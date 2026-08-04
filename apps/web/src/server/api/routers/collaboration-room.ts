import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { clientIdSchema } from "@drawstuff/collaboration/protocol";
import { roomRoleSchema } from "@drawstuff/collaboration/room-auth";

import { env } from "@/env";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { pushRelayRoomControl } from "@/server/collab/relay-control";
import {
  bumpRoomAuthRevision,
  createRoomId,
  DEFAULT_ROOM_TTL_MINUTES,
  ensureRoomMembership,
  issueRoomJoinToken,
  listActiveRoomMemberIds,
  listRoomMembers,
  lockRoom,
  MAX_ROOM_TTL_MINUTES,
  resolveRoomAccess,
  type Database,
  type RoomAccess,
  type RoomRecord,
  type RoomTransaction,
} from "@/server/collab/rooms";
import {
  collaborationRoom,
  collaborationRoomMember,
  scene,
} from "@/server/db/schema";

/**
 * Collaboration room lifecycle and authorization API (Plan 13).
 *
 * Every procedure is `protectedProcedure`: anonymous room access is off, and
 * turning it on would require a deliberate new decision, not a config flag.
 * The room link is a locator, not a credential — a caller still has to pass
 * `resolveRoomAccess`, which is the only place a role is decided and the only
 * input to token issuance.
 */

const roomIdInput = z.string().min(1).max(64);

/** Only the owner may change a room's shape or membership. */
const ownerRoleSchema = roomRoleSchema.exclude(["owner"]);

const linkRoleSchema = z.enum(["none", "viewer", "editor"]);

const accessError = (access: Exclude<RoomAccess, { status: "ok" }>) => {
  switch (access.status) {
    case "not-found":
      return new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
    case "ended":
      return new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This collaboration room has ended.",
      });
    case "expired":
      return new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This collaboration room has expired.",
      });
    case "forbidden":
      return new TRPCError({
        code: "FORBIDDEN",
        message: "You do not have access to this collaboration room.",
      });
  }
};

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
    if (access.status !== "ok") throw accessError(access);
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
        linkRole: linkRoleSchema.default("none"),
        ttlMinutes: z
          .number()
          .int()
          .positive()
          .max(MAX_ROOM_TTL_MINUTES)
          .default(DEFAULT_ROOM_TTL_MINUTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
          .set({ expiresAt, linkRole: input.linkRole, updatedAt: now })
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
          linkRole: input.linkRole,
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
    .input(z.object({ roomId: roomIdInput }))
    .query(async ({ ctx, input }) => {
      const access = await resolveRoomAccess(ctx.db, {
        roomId: input.roomId,
        userId: ctx.auth.user.id,
        now: new Date(),
      });
      if (access.status !== "ok") throw accessError(access);
      return {
        ...roomSummary(access.room),
        role: access.role,
        members: await listRoomMembers(ctx.db, access.room.roomId),
      };
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
      });
      // Not authorized is reported as "no room": a scene's collaboration state
      // is not something an unauthorized caller gets to observe.
      if (access.status !== "ok") return null;
      return { ...roomSummary(access.room), role: access.role };
    }),

  /**
   * Issues a short-lived join token for one client instance. This is the only
   * way a client can reach the relay, and the token is bound to the role
   * resolved here, so a viewer cannot obtain an editor connection.
   */
  join: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        clientId: z.string().pipe(clientIdSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;
      const now = new Date();
      // Resolving access, recording membership and signing the token all run
      // under the room lock, so a revocation that commits mid-request either
      // happens entirely before this (and the join is refused) or entirely
      // after it (and the relay closes the session it opened).
      return withLockedRoom(
        ctx.db,
        { roomId: input.roomId, userId, now },
        async (tx, access) => {
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
            clientId: input.clientId,
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
            relayUrl: env.NEXT_PUBLIC_COLLAB_RELAY_URL,
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
      const { room, authRevision } = await withLockedRoom(
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
          return {
            room: access.room,
            authRevision: await bumpRoomAuthRevision(tx, access.room, now),
          };
        },
      );
      const relay = await pushRelayRoomControl({
        action: "revoke-member",
        roomId: room.roomId,
        authGeneration: room.authGeneration,
        authRevision,
        userId,
        now,
      });
      return { left: true, relayEnforced: relay.enforced };
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
      const { room, authRevision } = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          if (input.userId === lockedRoom.ownerId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "The room owner's role cannot be changed.",
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
          return {
            room: lockedRoom,
            authRevision: await bumpRoomAuthRevision(tx, lockedRoom, now),
          };
        },
      );

      // The role a live socket carries came from its token, so a change only
      // takes effect on reconnect: close the member's sessions to force it.
      // The member's next token is issued at the bumped revision, so it
      // outranks this cutoff and the re-grant is usable immediately.
      const relay = await pushRelayRoomControl({
        action: "revoke-member",
        roomId: room.roomId,
        authGeneration: room.authGeneration,
        authRevision,
        userId: input.userId,
        now,
      });
      return { role: input.role, relayEnforced: relay.enforced };
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
      const { room, authRevision } = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          if (input.userId === lockedRoom.ownerId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "The room owner cannot be removed.",
            });
          }
          await tx
            .update(collaborationRoomMember)
            .set({ revokedAt: now, updatedAt: now })
            .where(
              and(
                eq(collaborationRoomMember.roomId, lockedRoom.roomId),
                eq(collaborationRoomMember.userId, input.userId),
                isNull(collaborationRoomMember.revokedAt),
              ),
            );
          return {
            room: lockedRoom,
            authRevision: await bumpRoomAuthRevision(tx, lockedRoom, now),
          };
        },
      );
      const relay = await pushRelayRoomControl({
        action: "revoke-member",
        roomId: room.roomId,
        authGeneration: room.authGeneration,
        authRevision,
        userId: input.userId,
        now,
      });
      return { removed: true, relayEnforced: relay.enforced };
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
      const room = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          await tx
            .update(collaborationRoom)
            .set({
              authGeneration: lockedRoom.authGeneration + 1,
              authRevision: lockedRoom.authRevision + 1,
              updatedAt: now,
            })
            .where(eq(collaborationRoom.roomId, lockedRoom.roomId));
          return lockedRoom;
        },
      );
      const nextGeneration = room.authGeneration + 1;

      const relay = await pushRelayRoomControl({
        action: "end-room",
        roomId: room.roomId,
        // The previous generation's channel is the one being emptied.
        authGeneration: room.authGeneration,
        authRevision: room.authRevision + 1,
        now,
      });
      return { authGeneration: nextGeneration, relayEnforced: relay.enforced };
    }),

  /** Closes the room: no further tokens, and every live session is dropped. */
  end: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const {
        room,
        memberCount,
        authRevision: revisionAfterEnd,
      } = await withLockedOwnedRoom(
        ctx.db,
        { roomId: input.roomId, userId: ctx.auth.user.id, now },
        async (tx, lockedRoom) => {
          await tx
            .update(collaborationRoom)
            .set({ status: "ended", endedAt: now, updatedAt: now })
            .where(eq(collaborationRoom.roomId, lockedRoom.roomId));
          // Membership rows stay as the room's history; the room is closed.
          const active = await listActiveRoomMemberIds(tx, lockedRoom.roomId);
          return {
            room: lockedRoom,
            memberCount: active.length,
            authRevision: await bumpRoomAuthRevision(tx, lockedRoom, now),
          };
        },
      );
      // Only the current generation can hold members: every rotation ends the
      // generation it left behind, and the lock above kept this read current.
      const relay = await pushRelayRoomControl({
        action: "end-room",
        roomId: room.roomId,
        authGeneration: room.authGeneration,
        authRevision: revisionAfterEnd,
        now,
      });
      return {
        ended: true,
        memberCount,
        relayEnforced: relay.enforced,
      };
    }),
});
