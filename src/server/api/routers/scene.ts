import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { eq } from "drizzle-orm";
import { scene } from "@/server/db/schema";

const saveSceneSchema = z.object({
  id: z.string().uuid().optional(), // 可選，有 ID 就更新，沒有就建立
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  projectId: z.string().uuid().optional(),
  data: z.string(), // 加密後的繪圖資料
});

export const sceneRouter = createTRPCRouter({
  saveScene: protectedProcedure
    .input(saveSceneSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        // 更新現有場景
        const updatedScene = await ctx.db
          .update(scene)
          .set({
            name: input.name,
            description: input.description,
            image: input.data,
            updatedAt: new Date(),
          })
          .where(eq(scene.id, input.id))
          .returning();

        return { id: updatedScene[0]?.id, action: "updated" };
      } else {
        // 建立新場景
        const newScene = await ctx.db
          .insert(scene)
          .values({
            name: input.name,
            description: input.description,
            projectId: input.projectId,
            userId: ctx.auth.user.id,
            image: input.data, // 儲存加密的繪圖資料
          })
          .returning();

        return { id: newScene[0]?.id, action: "created" };
      }
    }),

  getScene: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const sceneData = await ctx.db.query.scene.findFirst({
        where: eq(scene.id, input.id),
      });
      return sceneData;
    }),

  getUserScenes: protectedProcedure.query(async ({ ctx }) => {
    const scenes = await ctx.db.query.scene.findMany({
      where: eq(scene.userId, ctx.auth.user.id),
      orderBy: (scene, { desc }) => [desc(scene.updatedAt)],
    });
    return scenes;
  }),

  deleteScene: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(scene).where(eq(scene.id, input.id));
      return { success: true };
    }),
});
