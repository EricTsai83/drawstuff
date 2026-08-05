import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  canonicalizeAssetIds,
  collaborationAssetManifestSchema,
  excalidrawFileIdSchema,
  MAX_ASSET_REGISTRATION_BATCH,
} from "@drawstuff/collaboration/asset";
import {
  roomAuthGenerationSchema,
  roomRoleCanEditScene,
} from "@drawstuff/collaboration/room-auth";

import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { listRoomAssets, registerRoomAssets } from "@/server/collab/assets";
import {
  lockRoom,
  resolveRoomAccess,
  type RoomAccess,
} from "@/server/collab/rooms";

/**
 * Collaboration asset metadata API (Plan 16).
 *
 * This is the identity half of the asset pipeline: peers agree on *which*
 * assets a room references before anything moves the bytes (Plan 17). The
 * authorization model is the room's, unchanged — `resolveRoomAccess` is the only
 * place a role is decided, reading the manifest requires room access, and adding
 * to it additionally requires a role that may mutate the scene. A viewer that
 * could extend the manifest would be editing the room's durable state through a
 * door the relay keeps shut.
 */

const roomIdInput = z.string().min(1).max(64);

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

export const collaborationAssetRouter = createTRPCRouter({
  /**
   * The current generation's manifest.
   *
   * `authGeneration` comes from the room row, never from the caller: a client
   * cannot ask for a retired generation's asset set, and a rotation makes the
   * answer legitimately empty rather than stale.
   */
  list: protectedProcedure
    .input(z.object({ roomId: roomIdInput }))
    .output(collaborationAssetManifestSchema)
    .query(async ({ ctx, input }) => {
      const access = await resolveRoomAccess(ctx.db, {
        roomId: input.roomId,
        userId: ctx.auth.user.id,
        now: new Date(),
      });
      if (access.status !== "ok") throw accessError(access);

      return {
        roomId: access.room.roomId,
        authGeneration: access.room.authGeneration,
        fileIds: await listRoomAssets(ctx.db, {
          roomId: access.room.roomId,
          authGeneration: access.room.authGeneration,
        }),
      };
    }),

  /**
   * Claims asset ids for the current generation. Idempotent: re-registering an
   * id already in the manifest is success, which is what makes a retry after a
   * dropped response safe.
   */
  register: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        /**
         * Generation the caller believes it is in, and required to still be
         * current. A manifest entry filed under a rotated generation would
         * describe assets sealed under a key no member can derive.
         */
        authGeneration: roomAuthGenerationSchema,
        fileIds: z
          .array(excalidrawFileIdSchema)
          .min(1)
          .max(MAX_ASSET_REGISTRATION_BATCH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const userId = ctx.auth.user.id;
      const fileIds = canonicalizeAssetIds(input.fileIds);

      // Authorization and the write share one transaction under the room lock,
      // the ordering every room lifecycle mutation uses (Plan 13): without it a
      // revocation committing in between would let a removed editor still
      // extend the room's manifest.
      return ctx.db.transaction(async (tx) => {
        await lockRoom(tx, input.roomId);
        const access = await resolveRoomAccess(tx, {
          roomId: input.roomId,
          userId,
          now,
        });
        if (access.status !== "ok") throw accessError(access);
        if (!roomRoleCanEditScene(access.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A viewer cannot register collaboration assets.",
          });
        }
        if (input.authGeneration !== access.room.authGeneration) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This collaboration room's authorization generation has changed.",
          });
        }

        const result = await registerRoomAssets(tx, {
          roomId: access.room.roomId,
          authGeneration: input.authGeneration,
          fileIds,
          userId,
          now,
        });
        if ("code" in result) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `This room already references ${result.current} of ${result.limit} allowed assets.`,
          });
        }
        return {
          authGeneration: input.authGeneration,
          registered: result.registered,
          alreadyPresent: result.alreadyPresent,
          fileIds: result.fileIds,
        };
      });
    }),
});
