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
            sceneData: input.data,
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
            sceneData: input.data, // 儲存加密的繪圖資料
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

  // Enriched list for dashboard/search: include project name and category names
  getUserScenesList: protectedProcedure
    .output(
      z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          projectId: z.string().uuid().optional(),
          projectName: z.string().optional(),
          thumbnail: z.string().optional(),
          sceneData: z.string().optional(),
          isArchived: z.boolean(),
          categories: z.array(z.string()),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const scenes = await ctx.db.query.scene.findMany({
        where: eq(scene.userId, ctx.auth.user.id),
        orderBy: (sceneTbl, { desc }) => [desc(sceneTbl.updatedAt)],
        with: {
          project: true,
          sceneCategories: {
            with: {
              category: true,
            },
          },
        },
      });

      return scenes.map((s) => {
        return {
          id: s.id,
          name: s.name,
          description: s.description ?? "",
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          projectId: s.projectId ?? undefined,
          projectName: s.project?.name ?? undefined,
          thumbnail:
            (s as unknown as { thumbnailUrl?: string }).thumbnailUrl ??
            undefined,
          sceneData:
            (s as unknown as { sceneData?: string }).sceneData ?? undefined,
          isArchived: s.isArchived,
          categories: (s.sceneCategories ?? [])
            .map((sc) => sc.category?.name)
            .filter((name): name is string => Boolean(name)),
        };
      });
    }),

  deleteScene: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(scene).where(eq(scene.id, input.id));
      return { success: true };
    }),
});
