import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { and, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { category, scene, sceneCategory, workspace } from "@/server/db/schema";
import { TRPCError } from "@trpc/server";
import { saveSceneSchema } from "@/lib/schemas/scene";

export const sceneRouter = createTRPCRouter({
  saveScene: protectedProcedure
    .input(saveSceneSchema)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      let sceneId: string | undefined;
      let action: "created" | "updated" = "created";

      // 若有指定 workspace，需要驗證所有權
      if (input.workspaceId !== undefined) {
        const [owned] = await ctx.db
          .select({ userId: workspace.userId })
          .from(workspace)
          .where(eq(workspace.id, input.workspaceId))
          .limit(1);
        if (!owned || owned.userId !== ctx.auth.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Invalid workspace",
          });
        }
      }

      if (input.id) {
        // 更新現有場景（僅限本人場景）
        const updatedScene = await ctx.db
          .update(scene)
          .set({
            name: input.name,
            description: input.description,
            sceneData: input.data,
            // 僅在有提供 workspaceId 時才更新，避免不小心清空
            ...(input.workspaceId !== undefined
              ? { workspaceId: input.workspaceId }
              : {}),
            updatedAt: now,
          })
          .where(
            and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
          )
          .returning();

        if (!updatedScene[0]?.id) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Scene not found",
          });
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
            workspaceId: input.workspaceId,
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
          workspaceId: z.string().uuid().optional(),
          workspaceName: z.string().optional(),
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
          workspace: {
            columns: {
              id: true,
              name: true,
            },
          },
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
          workspaceId: s.workspaceId ?? undefined,
          workspaceName: s.workspace?.name ?? undefined,
          thumbnail: s.thumbnailUrl ?? undefined,
          sceneData: s.sceneData ?? undefined,
          isArchived: s.isArchived,
          categories: (s.sceneCategories ?? [])
            .map((sc) => sc.category?.name)
            .filter((name): name is string => Boolean(name)),
        };
      });
    }),

  // Infinite list for dashboard/search
  getUserScenesInfinite: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).optional(),
        cursor: z
          .object({
            updatedAt: z.date(),
            id: z.string().uuid(),
          })
          .optional(),
        workspaceId: z.string().uuid().optional(),
        // 用於重置查詢 key（後端暫不進行全文搜尋）
        search: z.string().optional(),
      }),
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            createdAt: z.date(),
            updatedAt: z.date(),
            workspaceId: z.string().uuid().optional(),
            workspaceName: z.string().optional(),
            thumbnail: z.string().optional(),
            sceneData: z.string().optional(),
            isArchived: z.boolean(),
            categories: z.array(z.string()),
          }),
        ),
        nextCursor: z
          .object({ updatedAt: z.date(), id: z.string().uuid() })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const limit = input.limit ?? 6;

      // 型別安全的條件累加（使用非空 tuple，避免 undefined 聯集）
      const whereClauses: [SQL, ...SQL[]] = [
        eq(scene.userId, ctx.auth.user.id),
      ];
      if (input.workspaceId) {
        whereClauses.push(eq(scene.workspaceId, input.workspaceId));
      }

      if (input.cursor) {
        // (updatedAt < cursor.updatedAt) OR (updatedAt = cursor.updatedAt AND id < cursor.id)
        const left: SQL = lt(scene.updatedAt, input.cursor.updatedAt);
        const right: SQL = and(
          eq(scene.updatedAt, input.cursor.updatedAt),
          lt(scene.id, input.cursor.id),
        )!;
        const cursorCond: SQL = or(left, right)!;
        whereClauses.push(cursorCond);
      }

      const rows = await ctx.db.query.scene.findMany({
        where: and(...whereClauses),
        orderBy: (sceneTbl, { desc }) => [
          desc(sceneTbl.updatedAt),
          desc(sceneTbl.id),
        ],
        limit: limit + 1,
        with: {
          workspace: {
            columns: {
              id: true,
              name: true,
            },
          },
          sceneCategories: {
            with: {
              category: {
                columns: { id: true, name: true },
              },
            },
          },
        },
      });

      let hasMore = false;
      let items = rows;
      if (rows.length > limit) {
        hasMore = true;
        items = rows.slice(0, limit);
      }

      const mapped = items.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? "",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        workspaceId: s.workspaceId ?? undefined,
        workspaceName: s.workspace?.name ?? undefined,
        thumbnail: s.thumbnailUrl ?? undefined,
        sceneData: s.sceneData ?? undefined,
        isArchived: s.isArchived,
        categories: (s.sceneCategories ?? [])
          .map((sc) => sc.category?.name)
          .filter((name): name is string => Boolean(name)),
      }));

      const nextCursor = hasMore
        ? {
            updatedAt: items[items.length - 1]!.updatedAt,
            id: items[items.length - 1]!.id,
          }
        : undefined;

      return { items: mapped, nextCursor };
    }),

  deleteScene: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(scene).where(eq(scene.id, input.id));
      return { success: true };
    }),
});
