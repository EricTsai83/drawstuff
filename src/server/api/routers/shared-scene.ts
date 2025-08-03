import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import { eq } from "drizzle-orm";
import { sharedScene } from "@/server/db/schema";

const saveSharedSceneSchema = z.object({
  id: z.string().min(1, "ID is required"),
  data: z.string().min(1, "Data is required"),
  binaryData: z.instanceof(Uint8Array).optional(),
});

const getSharedSceneSchema = z.object({
  id: z.string().min(1, "ID is required"),
});

export const sharedSceneRouter = createTRPCRouter({
  saveSharedScene: publicProcedure
    .input(saveSharedSceneSchema)
    .mutation(async ({ ctx, input }) => {
      const sceneData = {
        id: input.id,
        data: input.data,
        updatedAt: new Date(),
      };

      // 如果有二進位資料，直接存儲（不需要轉換）
      if (input.binaryData) {
        sceneData.binaryData = input.binaryData;
      }

      const result = await ctx.db
        .insert(sharedScene)
        .values(sceneData)
        .onConflictDoUpdate({
          target: sharedScene.id,
          set: {
            data: input.data,
            binaryData: input.binaryData,
            updatedAt: new Date(),
          },
        })
        .returning();

      return { id: result[0]?.id, action: "saved" };
    }),

  getSharedScene: publicProcedure
    .input(getSharedSceneSchema)
    .query(async ({ ctx, input }) => {
      const sceneData = await ctx.db.query.sharedScene.findFirst({
        where: eq(sharedScene.id, input.id),
      });

      // binaryData 會自動轉換為 Uint8Array
      return sceneData;
    }),

  deleteSharedScene: publicProcedure
    .input(getSharedSceneSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(sharedScene).where(eq(sharedScene.id, input.id));
      return { success: true };
    }),
});
