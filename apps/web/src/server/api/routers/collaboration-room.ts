import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { decodeBase64, encodeBase64 } from "@drawstuff/collaboration/base64";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
import {
  roomAuthGenerationSchema,
  roomRoleSchema,
} from "@drawstuff/collaboration/room-auth";

import { env } from "@/env";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import {
  dispatchControlOutboxEvent,
  enqueueRoomControlEvent,
  type ControlOutboxEvent,
} from "@/server/collab/control-outbox";
import {
  collaborationRoomsDisabled,
  collaborationRoomsDisabledError,
  resolveRelayUrl,
} from "@/server/collab/relay-routing";
import {
  bumpRoomAuthRevision,
  createRoomId,
  DEFAULT_ROOM_TTL_MINUTES,
  ensureRoomMembership,
  issueRoomJoinToken,
  listRoomMembers,
  lockRoom,
  MAX_ROOM_TTL_MINUTES,
  resolveRoomAccess,
  roomAccessError,
  roomIdInputSchema,
  type Database,
  type RoomAccess,
  type RoomRecord,
  type RoomTransaction,
} from "@/server/collab/rooms";
import {
  collaborationRoom,
  collaborationRoomMember,
  scene,
  user,
} from "@/server/db/schema";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";
import { endRoom } from "@/server/admin/retirement";

/**
 * Collaboration room lifecycle and authorization API.
 *
 * Every procedure is `protectedProcedure`: anonymous room access is off, and
 * turning it on would require a deliberate new decision, not a config flag.
 * The room link is a locator, not a credential — a caller still has to pass
 * `resolveRoomAccess`, which is the only place a role is decided and the only
 * input to token issuance.
 */

const roomIdInput = roomIdInputSchema;

/** Only the owner may change a room's shape or membership. */
const ownerRoleSchema = roomRoleSchema.exclude(["owner"]);

const linkRoleSchema = z.enum(["none", "viewer", "editor"]);

/**
 * Base64 of exactly `KEYCHECK_CIPHERTEXT_BYTES` bytes. The sealed key-check
 * value has a constant size, so the base64 length is pinned too; the decoded
 * length is still checked because base64 length alone is ambiguous by up to
 * two padding bytes.
 */
const KEYCHECK_BASE64_LENGTH = Math.ceil(KEYCHECK_CIPHERTEXT_BYTES / 3) * 4;

const keyCheckBase64Schema = z
  .string()
  .length(KEYCHECK_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

const roomSummary = (room: RoomRecord) => ({
  roomId: room.roomId,
  sceneId: room.sceneId,
  authGeneration: room.authGeneration,
  linkRole: room.linkRole as z.infer<typeof linkRoleSchema>,
  status: room.status,
  expiresAt: room.expiresAt,
});

type AuthorizedRoom = Extract<RoomAccess, { status: "ok" }>;

/**
 * What a mutation reports about live sessions: `enforced` means the assigned
 * provider confirmed closing them; `pending` means the authorization change
 * is committed (new joins are already refused) and the enforcement event is
 * queued for durable delivery. Never claim the socket side of a change the
 * provider has not confirmed.
 */
type EnforcementState = "enforced" | "pending";

/**
 * Post-commit best-effort delivery of the event a mutation enqueued.
 * `dispatchControlOutboxEvent` is contractually non-throwing: the mutation
 * has already committed, so nothing on this path may turn into an API error
 * the caller would misread as "the change did not happen".
 */
async function dispatchEnqueued(
  db: Database,
  event: ControlOutboxEvent,
): Promise<EnforcementState> {
  const result = await dispatchControlOutboxEvent(db, event);
  return result.enforced ? "enforced" : "pending";
}

/**
 * Runs `body` with the room row locked for update.
 *
 * Token issuance and every lifecycle change take this lock, so they serialize:
 * a token can never be signed from an authorization state that a concurrent
 * revocation has already replaced, and two lifecycle changes cannot each act on
 * a generation the other has moved past. The relay push deliberately happens
 * after the transaction commits — the database is the source of truth, and no
 * lock is held across a network call.
 */
async function withLockedRoom<T>(
  db: Database,
  params: { roomId: string; userId: string; now: Date },
  body: (tx: RoomTransaction, access: AuthorizedRoom) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockRoom(tx, params.roomId);
    const access = await resolveRoomAccess(tx, params);
    if (access.status !== "ok") throw roomAccessError(access);
    return body(tx, access);
  });
}

/** Same, but rejects anything except the room's owner. */
async function withLockedOwnedRoom<T>(
  db: Database,
  params: { roomId: string; userId: string; now: Date },
  body: (tx: RoomTransaction, room: RoomRecord) => Promise<T>,
): Promise<T> {
  return withLockedRoom(db, params, async (tx, access) => {
    if (access.role !== "owner") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the room owner can perform this action.",
      });
    }
    return body(tx, access.room);
  });
}

export const collaborationRoomRouter = createTRPCRouter({
  /**
   * Opens (or re-uses) the active room for a scene the caller owns. Scene
   * ownership is the authorization source: rooms never widen who can reach a
   * scene, they only decide who can edit it live.
   */
  create: protectedProcedure
    .input(
      z.object({
        sceneId: z.uuid(),
        /**
         * Optional on purpose: omitted means "leave the room's link role
         * alone". Re-running 開始共編 refreshes an existing room's window, and
         * a default here would silently reset a link-editor room back to
         * invite-only in the same write. Only a brand-new room falls back to
         * `none`.
         */
        linkRole: linkRoleSchema.optional(),
        ttlMinutes: z
          .number()
          .int()
          .positive()
          .max(MAX_ROOM_TTL_MINUTES)
          .default(DEFAULT_ROOM_TTL_MINUTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (collaborationRoomsDisabled()) throw collaborationRoomsDisabledError();
      const userId = ctx.auth.user.id;
      const now = new Date();
      const ownedScene = await ctx.db.query.scene.findFirst({
        where: eq(scene.id, input.sceneId),
        columns: { id: true, userId: true },
      });
      if (!ownedScene) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found." });
      }
      if (ownedScene.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the scene owner can start collaboration.",
        });
      }

      const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
      const existing = await ctx.db.query.collaborationRoom.findFirst({
        where: and(
          eq(collaborationRoom.sceneId, input.sceneId),
          eq(collaborationRoom.status, "active"),
        ),
      });
      // One active room per scene (enforced by a partial unique index too):
      // re-opening refreshes the window instead of creating a second room.
      // The status predicate matters: the room may have been ended between the
      // read above and this write, and refreshing an ended row would hand back
      // a room nobody can join.
      if (existing) {
        const [refreshed] = await ctx.db
          .update(collaborationRoom)
          .set({
            expiresAt,
            updatedAt: now,
            ...(input.linkRole !== undefined
              ? { linkRole: input.linkRole }
              : {}),
          })
          .where(
            and(
              eq(collaborationRoom.roomId, existing.roomId),
              eq(collaborationRoom.status, "active"),
            ),
          )
          .returning();
        if (refreshed) return roomSummary(refreshed);
        // It ended under us: fall through and open a fresh room.
      }

      // Two concurrent creates both see "no active room": let the partial
      // unique index arbitrate and return the room that won instead of
      // failing the loser's request.
      const [created] = await ctx.db
        .insert(collaborationRoom)
        .values({
          roomId: createRoomId(),
          sceneId: input.sceneId,
          ownerId: userId,
          linkRole: input.linkRole ?? "none",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        // Matches the partial unique index so Postgres can infer it.
        .onConflictDoNothing({
          target: collaborationRoom.sceneId,
          where: sql`status = 'active'`,
        })
        .returning();
      const room =
        created ??
        (await ctx.db.query.collaborationRoom.findFirst({
          where: and(
            eq(collaborationRoom.sceneId, input.sceneId),
            eq(collaborationRoom.status, "active"),
          ),
        }));
      if (!room) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await ensureRoomMembership(ctx.db, {
        roomId: room.roomId,
        userId,
        role: "owner",
        now,
      });
      return roomSummary(room);
    }),

  /** Room state for the collaboration panel; requires room access. */
  get: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        /** Revoked members ride along only when the caller asks for them. */
        includeRevokedMembers: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const access = await resolveRoomAccess(ctx.db, {
        roomId: input.roomId,
        userId: ctx.auth.user.id,
        now: new Date(),
      });
      if (access.status !== "ok") throw roomAccessError(access);
      return {
        ...roomSummary(access.room),
        role: access.role,
        members: await listRoomMembers(ctx.db, access.room.roomId, {
          includeRevoked: input.includeRevokedMembers,
        }),
        /**
         * The key-check value rides on `get` so verifying a link costs no
         * extra round-trip, and `get` is what the client calls *before* it
         * touches the canvas — the whole point is to refuse a wrong-key link
         * before the user's canvas is cleared.
         */
        keyCheckBase64: access.room.keyCheck
          ? encodeBase64(access.room.keyCheck)
          : null,
      };
    }),

  /**
   * Stores the room's key-check value. Owner-only, and only for the
   * current generation: the value is sealed against (room, generation), so
   * filing it under any other generation would store a value no link could
   * ever verify against.
   *
   * The server cannot validate the ciphertext beyond its exact size — the room
   * key never leaves the browser — so the owner's client is the only party
   * that can produce it, right after `create` and `rotateGeneration` mint a
   * fresh key. An upsert by design: re-running "開始共編" on a room whose key
   * was lost replaces both the key and its check value.
   */
  setKeyCheck: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        authGeneration: roomAuthGenerationSchema,
        keyCheckBase64: keyCheckBase64Schema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Canonical decode through the shared codec: `Buffer.from` leniency must
      // not decide what counts as a stored key-check value.
      const decodedKeyCheck = decodeBase64(input.keyCheckBase64, {
        maxBytes: KEYCHECK_CIPHERTEXT_BYTES,
      });
      if (
        !decodedKeyCheck.ok ||
        decodedKeyCheck.bytes.byteLength !== KEYCHECK_CIPHERTEXT_BYTES
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Key-check value size is out of range.",
        });
      }
      const keyCheck = decodedKeyCheck.bytes;
      const now = new Date();
      await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, room) => {
          if (input.authGeneration !== room.authGeneration) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "This collaboration room's authorization generation has changed.",
            });
          }
          // Immutable within a generation. `create` returns the existing
          // active room, so without this a second "開始共編" would replace the
          // verifier mid-generation: every link holding the original key would
          // fail the gate, while the replacement key passes it but cannot open
          // anything sealed before it — and the pre-join verification could be
          // invalidated between `get` and `join`. Replacing the value is what
          // `rotateGeneration` is for; it clears the column in the same update
          // that moves the generation.
          if (room.keyCheck !== null) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This room already has a key-check value; rotate the generation to replace it.",
            });
          }
          await tx
            .update(collaborationRoom)
            .set({ keyCheck, updatedAt: now })
            .where(eq(collaborationRoom.roomId, room.roomId));
        },
      );
      return { set: true };
    }),

  /** Finds the caller's active room for a scene, if any. */
  getActiveForScene: protectedProcedure
    .input(z.object({ sceneId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const room = await ctx.db.query.collaborationRoom.findFirst({
        where: and(
          eq(collaborationRoom.sceneId, input.sceneId),
          eq(collaborationRoom.status, "active"),
        ),
      });
      if (!room) return null;
      const access = await resolveRoomAccess(ctx.db, {
        roomId: room.roomId,
        userId: ctx.auth.user.id,
        now: new Date(),
        // Already read above; resolving access must not re-fetch the row.
        room,
      });
      // Not authorized is reported as "no room": a scene's collaboration state
      // is not something an unauthorized caller gets to observe.
      if (access.status !== "ok") return null;
      return { ...roomSummary(access.room), role: access.role };
    }),

  /**
   * Issues a short-lived join token. This is the only way a client can reach
   * the relay, and the token is bound to the role resolved here, so a viewer
   * cannot obtain an editor connection. The input deliberately carries no
   * client-selected identity: nothing the caller provides is signed
   * into the token.
   */
  join: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .mutation(async ({ ctx, input }) => {
      if (collaborationRoomsDisabled()) throw collaborationRoomsDisabledError();
      const userId = ctx.auth.user.id;
      // After authentication and input validation, before the room lookup: the
      // budget belongs to the caller's own identity, so it costs no database
      // work to refuse, and a caller cannot spend anybody else's. Redis being
      // degraded only skips this — the lock, the access resolution and the
      // key-check requirement below are unaffected.
      await enforceCollaborationRateLimit({
        operation: "join",
        identifier: userId,
      });
      const now = new Date();
      // Resolving access, recording membership and signing the token all run
      // under the room lock, so a revocation that commits mid-request either
      // happens entirely before this (and the join is refused) or entirely
      // after it (and the relay closes the session it opened).
      return withLockedRoom(
        ctx.db,
        { roomId: input.roomId, userId, now },
        async (tx, access) => {
          // No token for a room whose key cannot be verified. The
          // client refuses such a room on its own, but that is a convention;
          // this is the invariant — an unverifiable room can never hold a
          // session, so nothing can write into it, whatever the client does.
          // Null only ever spans the moment between create/rotate and the
          // owner's setKeyCheck, before any link exists to share.
          if (access.room.keyCheck === null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "This collaboration room's encryption is not set up yet.",
            });
          }
          // A link-role joiner becomes a visible, revocable participant.
          await ensureRoomMembership(tx, {
            roomId: access.room.roomId,
            userId,
            role: access.role,
            now,
          });
          const issued = issueRoomJoinToken({
            room: access.room,
            role: access.role,
            userId,
            secret: env.COLLAB_JOIN_TOKEN_SECRET,
            now,
          });
          return {
            token: issued.token,
            role: issued.role,
            roomId: issued.roomId,
            sceneId: access.room.sceneId,
            authGeneration: issued.authGeneration,
            tokenExpiresAt: issued.expiresAt,
            relayUrl: resolveRelayUrl(access.room),
          };
        },
      );
    }),

  /**
   * Ends the caller's own participation. The owner cannot leave their own room
   * (there would be no one left to end it) — they use `end` instead.
   */
  leave: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;
      const now = new Date();
      const outboxEvent = await withLockedRoom(
        ctx.db,
        { roomId: input.roomId, userId, now },
        async (tx, access) => {
          if (access.role === "owner") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The room owner ends the room instead of leaving it.",
            });
          }
          await tx
            .update(collaborationRoomMember)
            .set({ revokedAt: now, updatedAt: now })
            .where(
              and(
                eq(collaborationRoomMember.roomId, access.room.roomId),
                eq(collaborationRoomMember.userId, userId),
                isNull(collaborationRoomMember.revokedAt),
              ),
            );
          return enqueueRoomControlEvent(tx, {
            roomId: access.room.roomId,
            authGeneration: access.room.authGeneration,
            authRevision: await bumpRoomAuthRevision(tx, access.room, now),
            action: "revoke-member",
            subjectUserId: userId,
            now,
          });
        },
      );
      return {
        left: true,
        enforcement: await dispatchEnqueued(ctx.db, outboxEvent),
      };
    }),

  /**
   * Changes what a signed-in user who only has the link may do. `none` makes
   * the room invite-only; it never affects existing membership rows.
   */
  setLinkRole: protectedProcedure
    .input(z.object({ roomId: roomIdInput, linkRole: linkRoleSchema }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, room) => {
          await tx
            .update(collaborationRoom)
            .set({ linkRole: input.linkRole, updatedAt: now })
            .where(eq(collaborationRoom.roomId, room.roomId));
        },
      );
      return { linkRole: input.linkRole };
    }),

  /** Grants or changes an explicit role for another user. Owner only. */
  setMemberRole: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        userId: z.string().min(1).max(128),
        role: ownerRoleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const outboxEvent = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          if (input.userId === lockedRoom.ownerId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "The room owner's role cannot be changed.",
            });
          }
          // A grant for an unknown user must be NOT_FOUND, not the FK
          // violation the insert below would otherwise surface as a 500.
          const targetUser = await tx.query.user.findFirst({
            where: eq(user.id, input.userId),
            columns: { id: true },
          });
          if (!targetUser) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "User not found.",
            });
          }
          await tx
            .insert(collaborationRoomMember)
            .values({
              roomId: lockedRoom.roomId,
              userId: input.userId,
              role: input.role,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                collaborationRoomMember.roomId,
                collaborationRoomMember.userId,
              ],
              // Re-granting also reinstates a previously revoked member.
              set: { role: input.role, revokedAt: null, updatedAt: now },
            });
          // The role a live socket carries came from its token, so a change
          // only takes effect on reconnect: close the member's sessions to
          // force it. The member's next token is issued at the bumped
          // revision, so it outranks this cutoff and the re-grant is usable
          // immediately.
          return enqueueRoomControlEvent(tx, {
            roomId: lockedRoom.roomId,
            authGeneration: lockedRoom.authGeneration,
            authRevision: await bumpRoomAuthRevision(tx, lockedRoom, now),
            action: "revoke-member",
            subjectUserId: input.userId,
            now,
          });
        },
      );
      return {
        role: input.role,
        enforcement: await dispatchEnqueued(ctx.db, outboxEvent),
      };
    }),

  /**
   * Withdraws a member's authorization. New joins are refused immediately and
   * the member's existing sockets are closed. This is authorization
   * revocation only: a member who already holds a room encryption key can
   * still read ciphertext captured earlier, which is what `rotateGeneration`
   * exists for.
   */
  removeMember: protectedProcedure
    .input(
      z.object({ roomId: roomIdInput, userId: z.string().min(1).max(128) }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const outboxEvent = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          if (input.userId === lockedRoom.ownerId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "The room owner cannot be removed.",
            });
          }
          const revoked = await tx
            .update(collaborationRoomMember)
            .set({ revokedAt: now, updatedAt: now })
            .where(
              and(
                eq(collaborationRoomMember.roomId, lockedRoom.roomId),
                eq(collaborationRoomMember.userId, input.userId),
                isNull(collaborationRoomMember.revokedAt),
              ),
            )
            .returning({ id: collaborationRoomMember.id });
          // Unknown user or never-joined member: report NOT_FOUND instead of
          // silently claiming a removal (and bumping the revision for nothing).
          if (revoked.length === 0) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "This user is not an active member of the room.",
            });
          }
          return enqueueRoomControlEvent(tx, {
            roomId: lockedRoom.roomId,
            authGeneration: lockedRoom.authGeneration,
            authRevision: await bumpRoomAuthRevision(tx, lockedRoom, now),
            action: "revoke-member",
            subjectUserId: input.userId,
            now,
          });
        },
      );
      return {
        removed: true,
        enforcement: await dispatchEnqueued(ctx.db, outboxEvent),
      };
    }),

  /**
   * Advances the room's authorization generation. Every outstanding token
   * becomes unusable and the relay channel for the previous generation is
   * emptied, which is the hook a future room key rotation binds to: only a new
   * generation gives cryptographic revocation, not member removal.
   */
  rotateGeneration: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const { nextGeneration, outboxEvent } = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          const nextGeneration = lockedRoom.authGeneration + 1;
          await tx
            .update(collaborationRoom)
            .set({
              authGeneration: nextGeneration,
              authRevision: lockedRoom.authRevision + 1,
              // The stored key-check value belongs to the previous generation
              // and the key being retired; cleared here so the row never pairs
              // a new generation with a stale value, and recomputed by the
              // owner's client via `setKeyCheck` right after this returns.
              keyCheck: null,
              updatedAt: now,
            })
            .where(eq(collaborationRoom.roomId, lockedRoom.roomId));
          return {
            nextGeneration,
            outboxEvent: await enqueueRoomControlEvent(tx, {
              roomId: lockedRoom.roomId,
              authGeneration: lockedRoom.authGeneration,
              authRevision: lockedRoom.authRevision + 1,
              action: "end-room",
              now,
            }),
          };
        },
      );
      return {
        authGeneration: nextGeneration,
        enforcement: await dispatchEnqueued(ctx.db, outboxEvent),
      };
    }),

  /** Closes the room: no further tokens, and every live session is dropped. */
  end: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .mutation(async ({ ctx, input }) => {
      const result = await endRoom({
        db: ctx.db,
        roomId: input.roomId,
        ownerUserId: ctx.auth.user.id,
      });
      if (!result.found)
        throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
      return {
        ended: true,
        memberCount: result.memberCount,
        enforcement: result.enforcement,
      };
    }),
});
