import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/server/api/trpc";
import { and, eq, lt, or, type SQL } from "drizzle-orm";
import {
  scene,
  fileRecord,
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
            revision: z.number().int().min(1),
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
            .map((sc) => sc.category?.name)
            .filter((name): name is string => Boolean(name)),
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
