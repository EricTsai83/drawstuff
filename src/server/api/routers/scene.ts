import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { and, eq, inArray } from "drizzle-orm";
import { category, scene, sceneCategory } from "@/server/db/schema";

const saveSceneSchema = z.object({
  id: z.string().uuid().optional(), // 可選，有 ID 就更新，沒有就建立
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  projectId: z.string().uuid().optional(),
  data: z.string(), // 加密後的繪圖資料
  // 允許同時提交分類標籤（以名稱為主）
  categories: z.array(z.string().min(1)).optional(),
});

export const sceneRouter = createTRPCRouter({
  saveScene: protectedProcedure
    .input(saveSceneSchema)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      let sceneId: string | undefined;
      let action: "created" | "updated" = "created";

      if (input.id) {
        // 更新現有場景（僅限本人場景）
        const updatedScene = await ctx.db
          .update(scene)
          .set({
            name: input.name,
            description: input.description,
            sceneData: input.data,
            updatedAt: now,
          })
          .where(
            and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
          )
          .returning();

        if (!updatedScene[0]?.id) {
          throw new Error("SCENE_NOT_FOUND_OR_FORBIDDEN");
        }

        sceneId = updatedScene[0]?.id;
        action = "updated";
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

        sceneId = newScene[0]?.id;
        action = "created";
      }

      // 分類同步（可選）：
      // - input.categories === undefined -> 不變更分類
      // - input.categories 提供（可為空陣列）-> 當作權威來源，執行完整同步（空陣列會清空所有分類）
      if (sceneId && input.categories !== undefined) {
        const trimmed = Array.from(
          new Set(
            input.categories
              .map((n) => n.trim())
              .filter((n): n is string => n.length > 0),
          ),
        );

        // 建立缺失的 category（若有）
        if (trimmed.length > 0) {
          const existing = await ctx.db
            .select()
            .from(category)
            .where(
              and(
                eq(category.userId, ctx.auth.user.id),
                inArray(category.name, trimmed),
              ),
            );
          const existingNames = new Set(existing.map((c) => c.name));
          const toCreate = trimmed.filter((n) => !existingNames.has(n));
          if (toCreate.length > 0) {
            await ctx.db
              .insert(category)
              .values(
                toCreate.map((name) => ({ name, userId: ctx.auth.user.id })),
              );
          }
        }

        // 計算目標分類 IDs（可為空）
        const targetIds = trimmed.length
          ? (
              await ctx.db
                .select()
                .from(category)
                .where(
                  and(
                    eq(category.userId, ctx.auth.user.id),
                    inArray(category.name, trimmed),
                  ),
                )
            ).map((c) => c.id)
          : [];

        // 取得目前場景的分類 id
        const current = await ctx.db
          .select({ categoryId: sceneCategory.categoryId })
          .from(sceneCategory)
          .where(eq(sceneCategory.sceneId, sceneId));
        const currentIds = new Set(current.map((c) => c.categoryId));

        const targetIdSet = new Set(targetIds);

        // 要新增的關聯
        const toAdd = targetIds.filter((id) => !currentIds.has(id));
        if (toAdd.length > 0) {
          await ctx.db
            .insert(sceneCategory)
            .values(toAdd.map((cid) => ({ sceneId, categoryId: cid })));
        }

        // 要移除的關聯（當 trimmed 為空時，這裡會移除所有現有分類）
        const toRemove = Array.from(currentIds).filter(
          (id) => !targetIdSet.has(id),
        );
        if (toRemove.length > 0) {
          await ctx.db
            .delete(sceneCategory)
            .where(
              and(
                eq(sceneCategory.sceneId, sceneId),
                inArray(sceneCategory.categoryId, toRemove),
              ),
            );

          // 立即清理：移除剛剛解除關聯且不再被任何場景引用的分類
          const stillReferenced = await ctx.db
            .select({ categoryId: sceneCategory.categoryId })
            .from(sceneCategory)
            .where(inArray(sceneCategory.categoryId, toRemove));
          const stillReferencedSet = new Set(
            stillReferenced.map((r) => r.categoryId),
          );
          const noLongerUsed = toRemove.filter(
            (id) => !stillReferencedSet.has(id),
          );
          if (noLongerUsed.length > 0) {
            await ctx.db
              .delete(category)
              .where(inArray(category.id, noLongerUsed));
          }
        }
      }

      return { id: sceneId, action };
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
              // Limit selected columns to avoid referencing non-existent columns on older DBs
              category: {
                columns: {
                  id: true,
                  name: true,
                },
              },
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
