import { TRPCError } from "@trpc/server";
import { z } from "zod";

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
  type RoomAccess,
} from "@/server/collab/rooms";
import {
  deleteRoomSnapshot,
  readRoomSnapshot,
  writeRoomSnapshot,
} from "@/server/collab/snapshots";

/**
 * Durable collaboration snapshot API (Plan 15).
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

const roomIdInput = z.string().min(1).max(64);

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
      if (access.status !== "ok") throw accessError(access);

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
          ciphertextBase64: Buffer.from(snapshot.ciphertext).toString("base64"),
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
      // held across work that has nothing to do with the database.
      const ciphertext = new Uint8Array(
        Buffer.from(input.ciphertextBase64, "base64"),
      );
      if (
        ciphertext.byteLength < MIN_SNAPSHOT_SEALED_BYTES ||
        ciphertext.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Snapshot ciphertext size is out of range.",
        });
      }

      // Authorization and the write share one transaction under the room lock,
      // the same ordering every room lifecycle mutation uses (Plan 13). Without
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
        if (access.status !== "ok") throw accessError(access);
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
   * next elected writer's canvas (Plan 34's recovery path for a snapshot
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
        if (access.status !== "ok") throw accessError(access);
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
