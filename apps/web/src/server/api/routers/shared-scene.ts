import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import { eq } from "drizzle-orm";
import {
  fileRecord,
  legacySharedSceneTombstone,
  sharedScene,
} from "@/server/db/schema";

// 依據 scene id 取得加密的場景資料（儲存在 scene.image）
export const sharedSceneRouter = createTRPCRouter({
  getCompressedBySharedSceneId: publicProcedure
    .input(z.object({ sharedSceneId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const result = await ctx.db.query.sharedScene.findFirst({
        where: eq(sharedScene.sharedSceneId, input.sharedSceneId),
        columns: {
          compressedData: true,
          documentVersion: true,
        },
      });
      const tombstone = result
        ? null
        : await ctx.db.query.legacySharedSceneTombstone.findFirst({
            where: eq(
              legacySharedSceneTombstone.sharedSceneId,
              input.sharedSceneId,
            ),
            columns: { sharedSceneId: true },
          });
      if (tombstone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "LEGACY_SHARE_EXPIRED",
        });
      }

      return {
        compressedData: result?.compressedData ?? null,
        documentVersion: result?.documentVersion ?? null,
      };
    }),
  getFileRecordsBySharedSceneId: publicProcedure
    .input(z.object({ sharedSceneId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const results = await ctx.db.query.fileRecord.findMany({
        where: eq(fileRecord.sharedSceneId, input.sharedSceneId),
        columns: {
          utFileKey: true,
          url: true,
          name: true,
          size: true,
        },
      });

      return {
        files: results.map((r) => ({
          utFileKey: r.utFileKey,
          url: r.url,
          name: r.name,
          size: r.size,
        })),
      };
    }),
});
