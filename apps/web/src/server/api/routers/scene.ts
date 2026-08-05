import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/server/api/trpc";
import {
  and,
  eq,
  ilike,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  category,
  scene,
  sceneCategory,
  fileRecord,
  workspace,
} from "@/server/db/schema";
import { TRPCError } from "@trpc/server";
import { QUERIES } from "@/server/db/queries";
import { saveSceneSchema, sceneNameSchema } from "@/lib/schemas/scene";
import { UTApi } from "uploadthing/server";
import { nanoid } from "nanoid";
import {
  saveOwnedScene,
  type SaveOwnedSceneResult,
} from "@/server/scene/save-owned-scene";
import { readReferencedSceneAssetIds } from "@/server/scene/referenced-assets";

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
      excalidrawFileId: z.string(),
      url: z.string(),
    }),
  ),
});

function normalizeSearchTerm(search: string | undefined): string | null {
  const trimmed = search?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

export const sceneRouter = createTRPCRouter({
  saveScene: protectedProcedure
    .input(saveSceneSchema)
    .mutation(async ({ ctx, input }) => {
      const saveResult: SaveOwnedSceneResult = await saveOwnedScene({
        userId: ctx.auth.user.id,
        input,
      });

      if (saveResult.status === "success") {
        return {
          id: saveResult.data.id,
          action: saveResult.data.action,
          revision: saveResult.data.revision,
          updatedAt: saveResult.data.updatedAt,
        };
      }

      if (saveResult.status === "forbidden") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: saveResult.message,
        });
      }

      if (saveResult.status === "not_found") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: saveResult.message,
        });
      }

      if (saveResult.status === "conflict") {
        throw new TRPCError({
          code: "CONFLICT",
          message: saveResult.message,
          cause: saveResult.data,
        });
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: saveResult.message,
      });
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
          revision: z.number().int().min(1),
          updatedAt: z.date(),
        })
        .nullable(),
    )
    .query(async ({ ctx, input }) => {
      const sceneMeta = await ctx.db.query.scene.findFirst({
        where: and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)),
        columns: {
          id: true,
          revision: true,
          updatedAt: true,
        },
      });
      return sceneMeta ?? null;
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
        categoryId: z.uuid().optional(),
        search: z.string().optional(),
        archived: z.boolean().default(false),
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
            revision: z.number().int().min(1),
            workspaceId: z.uuid().optional(),
            workspaceName: z.string().optional(),
            thumbnail: z.string().optional(),
            sceneData: z.string().optional(),
            isArchived: z.boolean(),
            isPublished: z.boolean(),
            publishedSlug: z.string().optional(),
            publishedAt: z.date().optional(),
            categories: z.array(z.object({ id: z.uuid(), name: z.string() })),
          }),
        ),
        nextCursor: z.object({ updatedAt: z.date(), id: z.uuid() }).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const limit = input.limit ?? 6;

      // 型別安全的條件累加（使用非空 tuple，避免 undefined 聯集）
      const whereClauses: [SQL, ...SQL[]] = [
        eq(scene.userId, ctx.auth.user.id),
        isNotNull(scene.sceneData),
        eq(scene.isArchived, input.archived),
      ];
      if (input.workspaceId) {
        whereClauses.push(eq(scene.workspaceId, input.workspaceId));
      }
      // 注意：relational query 的 where 會把內嵌 sql 中其他表的欄位重寫成主表
      // alias（造成 "scene"."category_id" 這類錯誤欄位），因此跨表條件一律用
      // query builder 子查詢表達，讓子查詢維持自己的 alias context。
      if (input.categoryId) {
        // 走 scene_category 的 (scene_id, category_id) unique index，避免全表掃描
        whereClauses.push(
          inArray(
            scene.id,
            ctx.db
              .select({ sceneId: sceneCategory.sceneId })
              .from(sceneCategory)
              .where(eq(sceneCategory.categoryId, input.categoryId)),
          ),
        );
      }

      const normalizedSearch = normalizeSearchTerm(input.search);
      if (normalizedSearch) {
        const pattern = `%${normalizedSearch}%`;
        whereClauses.push(
          or(
            ilike(scene.name, pattern),
            ilike(scene.description, pattern),
            inArray(
              scene.workspaceId,
              ctx.db
                .select({ id: workspace.id })
                .from(workspace)
                .where(
                  and(
                    eq(workspace.userId, ctx.auth.user.id),
                    ilike(workspace.name, pattern),
                  ),
                ),
            ),
            inArray(
              scene.id,
              ctx.db
                .select({ sceneId: sceneCategory.sceneId })
                .from(sceneCategory)
                .innerJoin(category, eq(sceneCategory.categoryId, category.id))
                .where(
                  and(
                    eq(category.userId, ctx.auth.user.id),
                    ilike(category.name, pattern),
                  ),
                ),
            ),
          )!,
        );
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

      const mapped = items.map((s) => {
        const revisionValue: unknown = s.revision;
        return {
          id: s.id,
          name: s.name,
          description: s.description ?? "",
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          revision:
            typeof revisionValue === "number" && Number.isInteger(revisionValue)
              ? revisionValue
              : 1,
          workspaceId: s.workspaceId ?? undefined,
          workspaceName: s.workspace?.name ?? undefined,
          thumbnail: s.thumbnailUrl ?? undefined,
          sceneData: s.sceneData ?? undefined,
          isArchived: s.isArchived,
          isPublished: s.isPublished,
          publishedSlug: s.publishedSlug ?? undefined,
          publishedAt: s.publishedAt ?? undefined,
          categories: (s.sceneCategories ?? [])
            .map((sc) => sc.category)
            .filter(
              (categoryRow): categoryRow is { id: string; name: string } =>
                Boolean(categoryRow),
            )
            .map((categoryRow) => ({
              id: categoryRow.id,
              name: categoryRow.name,
            })),
        };
      });

      const nextCursor = hasMore
        ? {
            updatedAt: items[items.length - 1]!.updatedAt,
            id: items[items.length - 1]!.id,
          }
        : undefined;

      return { items: mapped, nextCursor };
    }),

  archive: protectedProcedure
    .input(
      z.object({ id: z.uuid(), expectedRevision: z.number().int().min(1) }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(scene)
        .set({
          isArchived: true,
          updatedAt: new Date(),
          revision: sql`${scene.revision} + 1`,
        })
        .where(
          and(
            eq(scene.id, input.id),
            eq(scene.userId, ctx.auth.user.id),
            eq(scene.revision, input.expectedRevision),
            eq(scene.isArchived, false),
          ),
        )
        .returning({ id: scene.id, revision: scene.revision });

      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Scene changed or is already archived",
        });
      }
      return updated;
    }),

  unarchive: protectedProcedure
    .input(
      z.object({ id: z.uuid(), expectedRevision: z.number().int().min(1) }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(scene)
        .set({
          isArchived: false,
          updatedAt: new Date(),
          revision: sql`${scene.revision} + 1`,
        })
        .where(
          and(
            eq(scene.id, input.id),
            eq(scene.userId, ctx.auth.user.id),
            eq(scene.revision, input.expectedRevision),
            eq(scene.isArchived, true),
          ),
        )
        .returning({ id: scene.id, revision: scene.revision });

      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Scene changed or is not archived",
        });
      }
      return updated;
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

  moveToWorkspace: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        workspaceId: z.uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the target workspace belongs to the user
      const targetWorkspace = await ctx.db.query.workspace.findFirst({
        where: and(
          eq(workspace.id, input.workspaceId),
          eq(workspace.userId, ctx.auth.user.id),
        ),
        columns: { id: true },
      });

      if (!targetWorkspace) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Target workspace not found or not owned by user",
        });
      }

      const [updated] = await ctx.db
        .update(scene)
        .set({
          workspaceId: input.workspaceId,
          updatedAt: new Date(),
          revision: sql`${scene.revision} + 1`,
        })
        .where(and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)))
        .returning({ id: scene.id, revision: scene.revision });

      if (!updated?.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      }

      return { id: updated.id, revision: updated.revision };
    }),

  renameScene: protectedProcedure
    .input(z.object({ id: z.uuid(), name: sceneNameSchema }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.db
        .update(scene)
        .set({
          name: input.name,
          updatedAt: new Date(),
          revision: sql`${scene.revision} + 1`,
        })
        .where(and(eq(scene.id, input.id), eq(scene.userId, ctx.auth.user.id)))
        .returning({ id: scene.id, revision: scene.revision });

      if (!updated[0]?.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      }

      return { id: updated[0].id, revision: updated[0].revision };
    }),

  publish: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .output(publishMutationOutput)
    .mutation(async ({ ctx, input }) => {
      const ownedScene = await ctx.db.query.scene.findFirst({
        where: and(
          eq(scene.id, input.id),
          eq(scene.userId, ctx.auth.user.id),
          isNotNull(scene.sceneData),
        ),
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
              excalidrawFileId: true,
            },
          },
        },
      });

      if (!publishedScene?.sceneData) {
        return null;
      }

      const referencedFileIds = await readReferencedSceneAssetIds(
        publishedScene.sceneData,
      );
      const visibleFiles =
        referencedFileIds === null
          ? []
          : (publishedScene.fileRecords ?? []).filter((file) =>
              referencedFileIds.has(file.excalidrawFileId),
            );

      return {
        id: publishedScene.id,
        name: publishedScene.name,
        description: publishedScene.description ?? "",
        sceneData: publishedScene.sceneData,
        thumbnailUrl: publishedScene.thumbnailUrl ?? undefined,
        updatedAt: publishedScene.updatedAt,
        publishedAt: publishedScene.publishedAt ?? undefined,
        authorName: publishedScene.user?.name ?? undefined,
        files: visibleFiles.map((file) => ({
          excalidrawFileId: file.excalidrawFileId,
          url: file.url,
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
          excalidrawFileId: true,
          size: true,
        },
      });

      return {
        files: results.map((r) => ({
          utFileKey: r.utFileKey,
          url: r.url,
          excalidrawFileId: r.excalidrawFileId,
          size: r.size,
        })),
      } as const;
    }),
});
