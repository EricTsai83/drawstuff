import { z } from "zod";
import { and, asc, count, eq } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { category, scene, sceneCategory } from "@/server/db/schema";
import {
  categoryAssignmentSchema,
  categoryCreateSchema,
  categoryDeleteSchema,
  categoryRenameSchema,
} from "@/lib/schemas/category";
import { TRPCError } from "@trpc/server";

const categorySummary = z.object({
  id: z.uuid(),
  name: z.string(),
});

const categoryListOutput = z.array(
  categorySummary.extend({
    sceneCount: z.number().int().min(0),
  }),
);

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    (error.cause as { code?: string }).code === "23505"
  );
}

export const categoryRouter = createTRPCRouter({
  // 使用者的所有分類（含使用中的場景數），依名稱排序
  list: protectedProcedure.output(categoryListOutput).query(async ({ ctx }) => {
    return await ctx.db
      .select({
        id: category.id,
        name: category.name,
        sceneCount: count(sceneCategory.id),
      })
      .from(category)
      .leftJoin(sceneCategory, eq(sceneCategory.categoryId, category.id))
      .where(eq(category.userId, ctx.auth.user.id))
      .groupBy(category.id)
      .orderBy(asc(category.name));
  }),

  create: protectedProcedure
    .input(categoryCreateSchema)
    .output(categorySummary)
    .mutation(async ({ ctx, input }) => {
      const [created] = await ctx.db
        .insert(category)
        .values({ name: input.name, userId: ctx.auth.user.id })
        .onConflictDoNothing({ target: [category.userId, category.name] })
        .returning({ id: category.id, name: category.name });

      if (!created) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Category already exists",
        });
      }
      return created;
    }),

  rename: protectedProcedure
    .input(categoryRenameSchema)
    .output(categorySummary)
    .mutation(async ({ ctx, input }) => {
      try {
        const [updated] = await ctx.db
          .update(category)
          .set({ name: input.name })
          .where(
            and(
              eq(category.id, input.id),
              eq(category.userId, ctx.auth.user.id),
            ),
          )
          .returning({ id: category.id, name: category.name });

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Category not found",
          });
        }
        return updated;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Category already exists",
          });
        }
        throw error;
      }
    }),

  // 刪除分類；scene_category 由 FK cascade 一併移除
  delete: protectedProcedure
    .input(categoryDeleteSchema)
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .delete(category)
        .where(
          and(eq(category.id, input.id), eq(category.userId, ctx.auth.user.id)),
        )
        .returning({ id: category.id });

      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Category not found",
        });
      }
      return { success: true } as const;
    }),

  assignToScene: protectedProcedure
    .input(categoryAssignmentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      const [ownedScene] = await ctx.db
        .select({ id: scene.id })
        .from(scene)
        .where(and(eq(scene.id, input.sceneId), eq(scene.userId, userId)))
        .limit(1);
      if (!ownedScene) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid scene" });
      }

      const [ownedCategory] = await ctx.db
        .select({ id: category.id })
        .from(category)
        .where(
          and(eq(category.id, input.categoryId), eq(category.userId, userId)),
        )
        .limit(1);
      if (!ownedCategory) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid category" });
      }

      // 冪等：重複指派不報錯
      await ctx.db
        .insert(sceneCategory)
        .values({ sceneId: input.sceneId, categoryId: input.categoryId })
        .onConflictDoNothing({
          target: [sceneCategory.sceneId, sceneCategory.categoryId],
        });

      return { success: true } as const;
    }),

  unassignFromScene: protectedProcedure
    .input(categoryAssignmentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      const [ownedScene] = await ctx.db
        .select({ id: scene.id })
        .from(scene)
        .where(and(eq(scene.id, input.sceneId), eq(scene.userId, userId)))
        .limit(1);
      if (!ownedScene) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid scene" });
      }

      const [ownedCategory] = await ctx.db
        .select({ id: category.id })
        .from(category)
        .where(
          and(eq(category.id, input.categoryId), eq(category.userId, userId)),
        )
        .limit(1);
      if (!ownedCategory) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid category" });
      }

      await ctx.db
        .delete(sceneCategory)
        .where(
          and(
            eq(sceneCategory.sceneId, input.sceneId),
            eq(sceneCategory.categoryId, input.categoryId),
          ),
        );

      return { success: true } as const;
    }),
});
