import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/server/api/trpc";
import { and, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import {
  category,
  scene,
  sceneCategory,
  workspace,
  fileRecord,
} from "@/server/db/schema";
import { TRPCError } from "@trpc/server";
import { QUERIES } from "@/server/db/queries";
import { saveSceneSchema, sceneNameSchema } from "@/lib/schemas/scene";
import { UTApi } from "uploadthing/server";
import { nanoid } from "nanoid";

const publishMutationOutput = z.object({
  slug: z.string(),
  alreadyPublished: z.boolean(),
});

const publicSceneOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  sceneData: z.string(),
  thumbnailUrl: z.string().optional(),
  updatedAt: z.date(),
  publishedAt: z.date().optional(),
  authorName: z.string().optional(),
  files: z.array(
    z.object({
      url: z.string(),
      name: z.string(),
      size: z.number(),
    }),
  ),
});

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
        if (owned?.userId !== ctx.auth.user.id) {
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
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const sceneData = await ctx.db.query.scene.findFirst({
        where: and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
      });
      return sceneData;
    }),

  getSceneMeta: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .output(
      z
        .object({
          id: z.uuid(),
          updatedAt: z.date(),
        })
        .nullable(),
    )
    .query(async ({ ctx, input }) => {
      const sceneMeta = await ctx.db.query.scene.findFirst({
        where: and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
        columns: {
          id: true,
          updatedAt: true,
        },
      });
      return sceneMeta ?? null;
    }),

  getUserScenes: protectedProcedure.query(async ({ ctx }) => {
    const scenes = await ctx.db.query.scene.findMany({
      where: eq(scene.userId, ctx.auth.user.id),
      orderBy: (scene, { desc }) => [desc(scene.updatedAt)],
    });
    return scenes;
  }),

  // Infinite list for dashboard/search
  getUserScenesInfinite: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).optional(),
        cursor: z
          .object({
            updatedAt: z.date(),
            id: z.uuid(),
          })
          .optional(),
        workspaceId: z.uuid().optional(),
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
            workspaceId: z.uuid().optional(),
            workspaceName: z.string().optional(),
            thumbnail: z.string().optional(),
            sceneData: z.string().optional(),
            isArchived: z.boolean(),
            isPublished: z.boolean(),
            publishedSlug: z.string().optional(),
            publishedAt: z.date().optional(),
            categories: z.array(z.string()),
          }),
        ),
        nextCursor: z
          .object({ updatedAt: z.date(), id: z.uuid() })
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
        isPublished: s.isPublished,
        publishedSlug: s.publishedSlug ?? undefined,
        publishedAt: s.publishedAt ?? undefined,
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
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      // 1) 擁有者驗證，同時取縮圖 key
      const ownerId = await QUERIES.getSceneOwnerId(input.id);
      if (!ownerId || ownerId !== ctx.auth.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid scene" });
      }

      const thumbnailKey = await QUERIES.getSceneThumbnailKey(input.id);

      // 2) 收集此場景所有 UploadThing 檔案的 key（場景資產 + 縮圖）
      const assetKeys = await QUERIES.getFileKeysBySceneIds([input.id]);
      const allKeys = Array.from(
        new Set<string>([
          ...assetKeys,
          ...(thumbnailKey ? [thumbnailKey] : []),
        ]),
      );

      // 3) 嘗試刪除遠端檔案（逐一刪除，錯誤則入延遲清理）
      if (allKeys.length > 0) {
        const utapi = new UTApi();
        for (const key of allKeys) {
          try {
            await utapi.deleteFiles([key]);
          } catch {
            await QUERIES.enqueueDeferredCleanup({
              utFileKey: key,
              reason: "delete-scene",
              context: { sceneId: input.id },
            });
          }
        }
      }

      // 4) 刪除場景（連鎖刪除 scene_categories 與 file_record）
      await ctx.db
        .delete(scene)
        .where(and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)));

      return { success: true };
    }),

  renameScene: protectedProcedure
    .input(z.object({ id: z.uuid(), name: sceneNameSchema }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.db
        .update(scene)
        .set({ name: input.name, updatedAt: new Date() })
        .where(and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)))
        .returning({ id: scene.id });

      if (!updated[0]?.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      }

      return { id: updated[0].id };
    }),

  publish: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .output(publishMutationOutput)
    .mutation(async ({ ctx, input }) => {
      const ownedScene = await ctx.db.query.scene.findFirst({
        where: and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
        columns: {
          id: true,
          publishedSlug: true,
          isPublished: true,
        },
      });

      if (!ownedScene) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      }

      if (ownedScene.isPublished && ownedScene.publishedSlug) {
        return {
          slug: ownedScene.publishedSlug,
          alreadyPublished: true,
        };
      }

      const MAX_SLUG_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
        const nextSlug = nanoid(12);

        try {
          const [updated] = await ctx.db
            .update(scene)
            .set({
              isPublished: true,
              publishedSlug: nextSlug,
              publishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
            )
            .returning({
              publishedSlug: scene.publishedSlug,
            });

          if (!updated?.publishedSlug) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Scene not found",
            });
          }

          return {
            slug: updated.publishedSlug,
            alreadyPublished: false,
          };
        } catch (error) {
          const isUniqueViolation =
            error instanceof Error &&
            "cause" in error &&
            typeof error.cause === "object" &&
            error.cause !== null &&
            "code" in error.cause &&
            (error.cause as { code?: string }).code === "23505";

          if (!isUniqueViolation) {
            throw error;
          }
        }
      }

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to publish scene",
      });
    }),

  unpublish: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(scene)
        .set({
          isPublished: false,
          publishedSlug: null,
          publishedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)))
        .returning({ id: scene.id });

      if (!updated?.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      }

      return { id: updated.id };
    }),

  getPublishedSceneBySlug: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .output(publicSceneOutput.nullable())
    .query(async ({ ctx, input }) => {
      const publishedScene = await ctx.db.query.scene.findFirst({
        where: and(
          eq(scene.publishedSlug, input.slug),
          eq(scene.isPublished, true),
        ),
        columns: {
          id: true,
          name: true,
          description: true,
          sceneData: true,
          thumbnailUrl: true,
          updatedAt: true,
          publishedAt: true,
        },
        with: {
          user: {
            columns: {
              name: true,
            },
          },
          fileRecords: {
            columns: {
              url: true,
              name: true,
              size: true,
            },
          },
        },
      });

      if (!publishedScene?.sceneData) {
        return null;
      }

      return {
        id: publishedScene.id,
        name: publishedScene.name,
        description: publishedScene.description ?? "",
        sceneData: publishedScene.sceneData,
        thumbnailUrl: publishedScene.thumbnailUrl ?? undefined,
        updatedAt: publishedScene.updatedAt,
        publishedAt: publishedScene.publishedAt ?? undefined,
        authorName: publishedScene.user?.name ?? undefined,
        files: (publishedScene.fileRecords ?? []).map((file) => ({
          url: file.url,
          name: file.name,
          size: file.size,
        })),
      };
    }),

  // 依 sceneId 取得雲端資產記錄（僅限擁有者）
  getFileRecordsBySceneId: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const ownerId = await QUERIES.getSceneOwnerId(input.id);
      if (!ownerId || ownerId !== ctx.auth.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid scene" });
      }

      const results = await ctx.db.query.fileRecord.findMany({
        where: eq(fileRecord.sceneId, input.id),
        columns: {
          utFileKey: true,
          url: true,
          name: true,
          size: true,
          contentHash: true,
        },
      });

      return {
        files: results.map((r) => ({
          utFileKey: r.utFileKey,
          url: r.url,
          name: r.name,
          size: r.size,
          contentHash: r.contentHash ?? undefined,
        })),
      } as const;
    }),
});
