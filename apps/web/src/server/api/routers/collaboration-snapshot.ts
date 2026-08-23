import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  decodeBase64,
  encodeBase64,
} from "@drawstuff/collaboration/base64";
import {
  roomAuthGenerationSchema,
  roomRoleCanEditScene,
} from "@drawstuff/collaboration/room-auth";
import {
  expectedSnapshotRevisionSchema,
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  MIN_SNAPSHOT_SEALED_BYTES,
  snapshotChecksumSchema,
  SNAPSHOT_CRYPTO_VERSION,
} from "@drawstuff/collaboration/snapshot";

import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import {
  lockRoom,
  resolveRoomAccess,
  roomAccessError,
  roomIdInputSchema,
} from "@/server/collab/rooms";
import {
  deleteRoomSnapshot,
  readRoomSnapshot,
  writeRoomSnapshot,
} from "@/server/collab/snapshots";
import {
  checkCollaborationRateLimit,
  enforceCollaborationRateLimitDecision,
} from "@/server/rate-limit/collaboration";

/**
 * Durable collaboration snapshot API.
 *
 * The authorization model is the room's, unchanged: `resolveRoomAccess` is the
 * only place a role is decided, reading requires room access, and writing
 * additionally requires a role that may mutate the scene. A snapshot is the room
 * baseline, so letting a viewer write one would be a way to edit the room
 * through the back door while the relay refuses the front one.
 *
 * Ciphertext travels as base64 rather than as bytes. superjson is the transport
 * transformer and does not carry `Uint8Array`, and base64 makes the byte bound
 * checkable before anything is decoded — the raw string length is bounded first,
 * then the decoded length, so an oversize payload is never materialized twice.
 */

const roomIdInput = roomIdInputSchema;

/**
 * Base64 of at most `MAX_SNAPSHOT_CIPHERTEXT_BYTES` bytes. Standard alphabet
 * with padding: `Buffer.from(…, "base64")` is lenient, so the shape is pinned
 * here instead of trusting the decode to reject garbage.
 */
const MAX_CIPHERTEXT_BASE64_LENGTH =
  Math.ceil(MAX_SNAPSHOT_CIPHERTEXT_BYTES / 3) * 4;

const ciphertextBase64Schema = z
  .string()
  .min(4)
  .max(MAX_CIPHERTEXT_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const collaborationSnapshotRouter = createTRPCRouter({
  /**
   * The room's current baseline, or `null` when this generation has none yet
   * (a brand-new room, or one whose generation was just rotated).
   *
   * `authGeneration` comes from the room row, never from the caller: a client
   * cannot ask for a previous generation's ciphertext, and it could not read it
   * anyway — the snapshot key is derived from the generation.
   */
  get: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .query(async ({ ctx, input }) => {
      const access = await resolveRoomAccess(ctx.db, {
        roomId: input.roomId,
        userId: ctx.auth.user.id,
        now: new Date(),
      });
      if (access.status !== "ok") throw roomAccessError(access);

      const snapshot = await readRoomSnapshot(ctx.db, {
        roomId: access.room.roomId,
        authGeneration: access.room.authGeneration,
      });
      if (!snapshot) {
        return { authGeneration: access.room.authGeneration, snapshot: null };
      }
      return {
        authGeneration: access.room.authGeneration,
        snapshot: {
          revision: snapshot.revision,
          cryptoVersion: snapshot.cryptoVersion,
          ciphertextBase64: encodeBase64(snapshot.ciphertext),
          byteLength: snapshot.byteLength,
          checksum: snapshot.checksum,
          updatedAt: snapshot.updatedAt,
        },
      };
    }),

  /**
   * Publishes a new baseline. `expectedRevision` is the optimistic guard: `0`
   * claims this generation has no snapshot yet, any other value claims the
   * snapshot is still at that revision. A losing writer gets `conflict` plus the
   * current revision rather than an error — the elected writer's next cadence
   * tick is the retry, and there is nothing to retry *now*: whoever won already
   * published a newer baseline.
   */
  put: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        /**
         * Generation the caller derived its snapshot key under. Required, and
         * required to still be current: the ciphertext is sealed against this
         * generation, so storing it under any other one produces a row nobody can
         * ever open — and the write would retire the readable row it replaced.
         */
        authGeneration: roomAuthGenerationSchema,
        /**
         * Untrusted scheduling hint. A caller may label an ordinary write as a
         * leave, so the only extra privilege it can unlock is another small,
         * independently rate-limited budget — never authorization or a bypass.
         */
        intent: z.enum(["cadence", "leave"]).default("cadence"),
        expectedRevision: expectedSnapshotRevisionSchema,
        cryptoVersion: z.literal(SNAPSHOT_CRYPTO_VERSION),
        ciphertextBase64: ciphertextBase64Schema,
        checksum: snapshotChecksumSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const userId = ctx.auth.user.id;

      // Decoded and bounded before the transaction opens: no row lock should be
      // held across work that has nothing to do with the database. The shared
      // codec's canonical decode replaces `Buffer.from` leniency, and its
      // encoded-length gate refuses an oversize payload before allocating it.
      const decoded = decodeBase64(input.ciphertextBase64, {
        maxBytes: MAX_SNAPSHOT_CIPHERTEXT_BYTES,
      });
      if (!decoded.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            decoded.reason === "oversize"
              ? "Snapshot ciphertext size is out of range."
              : "Snapshot ciphertext is not canonical base64.",
        });
      }
      const ciphertext = decoded.bytes;
      if (ciphertext.byteLength < MIN_SNAPSHOT_SEALED_BYTES) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Snapshot ciphertext size is out of range.",
        });
      }

      // This limiter's budget belongs to the *room*, not to the caller, which
      // makes the order it runs in part of its correctness: a caller who has
      // not been shown to have access must not be able to spend a room's
      // budget, or exhausting somebody else's snapshot writes would cost
      // nothing but a room id. So access is resolved first — unlocked, and
      // therefore explicitly *not* the authorization decision; that stays
      // inside the transaction below, which is the only place a write happens.
      // The role check is repeated here for the same reason: a viewer cannot
      // write, so a viewer must not be able to spend the writers' budget.
      const preAccess = await resolveRoomAccess(ctx.db, {
        roomId: input.roomId,
        userId,
        now,
      });
      if (preAccess.status !== "ok") throw roomAccessError(preAccess);
      if (!roomRoleCanEditScene(preAccess.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "A viewer cannot publish a collaboration snapshot.",
        });
      }
      // Before the row lock and before the transaction opens: a refusal must
      // not have taken a lock other writers are queued behind.
      let rateLimitDecision = await checkCollaborationRateLimit({
        operation: "snapshot-put",
        identifier: preAccess.room.roomId,
      });
      if (rateLimitDecision.status === "limited" && input.intent === "leave") {
        // Two tokens cover a final write and its one allowed conflict retry.
        // JSON encoding avoids ambiguous concatenation while keeping both
        // components canonical server-side values.
        rateLimitDecision = await checkCollaborationRateLimit({
          operation: "snapshot-finalize",
          identifier: JSON.stringify([preAccess.room.roomId, userId]),
        });
      }
      enforceCollaborationRateLimitDecision(rateLimitDecision);

      // Authorization and the write share one transaction under the room lock,
      // the same ordering every room lifecycle mutation uses. Without
      // it, a removal or a downgrade committing between the access check and the
      // write would let an already-revoked editor still replace the room's
      // durable baseline.
      return ctx.db.transaction(async (tx) => {
        await lockRoom(tx, input.roomId);
        const access = await resolveRoomAccess(tx, {
          roomId: input.roomId,
          userId,
          now,
        });
        if (access.status !== "ok") throw roomAccessError(access);
        // A viewer receives the baseline but never defines it. The relay refuses
        // its realtime mutations; this refuses the durable equivalent.
        if (!roomRoleCanEditScene(access.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A viewer cannot publish a collaboration snapshot.",
          });
        }
        // A rotation that commits between the caller's key derivation and this
        // write must not silently retarget the ciphertext: the bytes are sealed
        // against a specific generation, so filing them under another one
        // produces a row nobody can ever open — and would retire the readable
        // row it replaced.
        if (input.authGeneration !== access.room.authGeneration) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This collaboration room's authorization generation has changed.",
          });
        }

        return writeRoomSnapshot(tx, {
          roomId: access.room.roomId,
          authGeneration: input.authGeneration,
          expectedRevision: input.expectedRevision,
          cryptoVersion: input.cryptoVersion,
          ciphertext,
          checksum: input.checksum,
          userId,
          now,
        });
      });
    }),

  /**
   * Deletes the current generation's baseline so the room re-seeds from the
   * next elected writer's canvas (the recovery path for a snapshot
   * sealed under the wrong key).
   *
   * Owner-only, and stricter than `put` on purpose: an editor replaces the
   * baseline with content every member can immediately see and dispute, while
   * a reset silently discards the room's only durable copy — a destructive
   * lifecycle decision, which this API consistently reserves for the owner.
   */
  reset: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const userId = ctx.auth.user.id;
      // Same lock ordering as `put`: a reset must not race a cadence write
      // into deleting a row it did not decide about.
      return ctx.db.transaction(async (tx) => {
        await lockRoom(tx, input.roomId);
        const access = await resolveRoomAccess(tx, {
          roomId: input.roomId,
          userId,
          now,
        });
        if (access.status !== "ok") throw roomAccessError(access);
        if (access.role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the room owner can reset the room's cloud canvas.",
          });
        }
        const deleted = await deleteRoomSnapshot(tx, {
          roomId: access.room.roomId,
          authGeneration: access.room.authGeneration,
        });
        return { reset: deleted };
      });
    }),
});
