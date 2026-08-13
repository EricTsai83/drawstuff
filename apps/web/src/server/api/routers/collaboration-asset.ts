import { z } from "zod";

import {
  canonicalizeAssetIds,
  collaborationAssetLookupSchema,
  excalidrawFileIdSchema,
  MAX_ASSET_LOOKUP_BATCH,
} from "@drawstuff/collaboration/asset";

import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { resolveRoomAssets } from "@/server/collab/assets";
import {
  resolveRoomAccess,
  roomAccessError,
  roomIdInputSchema,
} from "@/server/collab/rooms";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";

/**
 * Collaboration asset lookup API for canonical identity and encrypted transfer.
 *
 * One question: *where are the bytes for these file ids, and which of them does
 * this room not have yet?* A peer already knows which assets it needs — the file
 * ids are on the image elements the realtime channel delivered — so it never
 * needs the room's whole asset list, and there is no procedure that returns one.
 *
 * The authorization model is the room's, unchanged: `resolveRoomAccess` is the
 * only place a role is decided, and reading requires room access. Writing is not
 * here at all — an asset enters the room through the upload route, which is the
 * only path that can pair a stored object with a record.
 *
 * What authorization protects is *discovery*. The URL this returns is a capability
 * that anybody holding it can fetch, and confidentiality does not depend on that:
 * the bytes behind it are sealed under a key derived from the room key, which the
 * backend never sees. So a leaked URL exposes ciphertext, and a member who loses
 * access loses the ability to find new URLs.
 */

const roomIdInput = roomIdInputSchema;

export const collaborationAssetRouter = createTRPCRouter({
  /**
   * Resolves a bounded batch of file ids for the room's current generation.
   *
   * `authGeneration` comes from the room row, never from the caller: a client
   * cannot ask for a retired generation's assets, and it could not open them
   * anyway — the asset key is derived from the generation.
   *
   * Ids the room has no ciphertext for come back in `missing` rather than as an
   * error. A peer broadcasts an image element the moment it is added and the
   * upload lands a beat later, so "not yet" is the ordinary state of a fresh
   * image; the caller retries those and only those.
   */
  resolve: protectedProcedure
    .input(
      z.object({
        roomId: roomIdInput,
        fileIds: z
          .array(excalidrawFileIdSchema)
          .min(1)
          .max(MAX_ASSET_LOOKUP_BATCH),
      }),
    )
    .output(collaborationAssetLookupSchema)
    .query(async ({ ctx, input }) => {
      // User-scoped, and taken before the room lookup: the batch is already
      // bounded at `MAX_ASSET_LOOKUP_BATCH` ids, so what is left to bound is
      // how often one caller may ask — and refusing here costs no query.
      await enforceCollaborationRateLimit({
        operation: "asset-resolve",
        identifier: ctx.auth.user.id,
      });
      const access = await resolveRoomAccess(ctx.db, {
        roomId: input.roomId,
        userId: ctx.auth.user.id,
        now: new Date(),
      });
      if (access.status !== "ok") throw roomAccessError(access);

      const fileIds = canonicalizeAssetIds(input.fileIds);
      const assets = await resolveRoomAssets(ctx.db, {
        roomId: access.room.roomId,
        authGeneration: access.room.authGeneration,
        fileIds,
      });
      const available = new Set(assets.map((asset) => asset.excalidrawFileId));

      return {
        roomId: access.room.roomId,
        authGeneration: access.room.authGeneration,
        assets,
        missing: fileIds.filter((fileId) => !available.has(fileId)),
      };
    }),
});
