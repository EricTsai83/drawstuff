import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import { eq } from "drizzle-orm";
import { sharedScene, fileRecord } from "@/server/db/schema";
import { enforcePublicSceneReadRateLimit } from "@/server/rate-limit/shared-scene";

// 分享連結的 id 由 nanoid() 產生（21 字元）；上限擋掉任意長度的輸入。
const sharedSceneIdInput = z.string().min(1).max(64);

// 兩個 procedure 都是 public（分享連結本身就是 capability），按客戶端 IP 限流。
// 依據 scene id 取得加密的場景資料（儲存在 scene.image）
export const sharedSceneRouter = createTRPCRouter({
  getCompressedBySharedSceneId: publicProcedure
    .input(z.object({ sharedSceneId: sharedSceneIdInput }))
    .query(async ({ ctx, input }) => {
      await enforcePublicSceneReadRateLimit(ctx.headers);
      const result = await ctx.db.query.sharedScene.findFirst({
        where: eq(sharedScene.sharedSceneId, input.sharedSceneId),
        columns: {
          compressedData: true,
        },
      });

      return { compressedData: result?.compressedData ?? null };
    }),
  getFileRecordsBySharedSceneId: publicProcedure
    .input(z.object({ sharedSceneId: sharedSceneIdInput }))
    .query(async ({ ctx, input }) => {
      await enforcePublicSceneReadRateLimit(ctx.headers);
      const results = await ctx.db.query.fileRecord.findMany({
        where: eq(fileRecord.sharedSceneId, input.sharedSceneId),
        // utFileKey 是 storage 層的內部身份，client 只需要 url：公開端點不再
        // 洩漏它。
        columns: {
          url: true,
          excalidrawFileId: true,
          size: true,
        },
      });

      return {
        files: results.map((r) => ({
          url: r.url,
          excalidrawFileId: r.excalidrawFileId,
          size: r.size,
        })),
      };
    }),
});
