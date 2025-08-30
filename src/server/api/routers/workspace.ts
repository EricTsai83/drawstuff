import { z } from "zod";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@/lib/schemas/workspace";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { eq } from "drizzle-orm";
import {
  workspace,
  userDefaultWorkspace,
  userLastActiveWorkspace,
} from "@/server/db/schema";
import { TRPCError } from "@trpc/server";

export const workspaceRouter = createTRPCRouter({
  // 一次回傳清單與 meta（default / lastActive）
  listWithMeta: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.auth.user.id;

    const workspaceRows = await ctx.db
      .select({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(eq(workspace.userId, userId))
      .orderBy(workspace.updatedAt);

    const [defaultWorkspaceMapping] = await ctx.db
      .select({ workspaceId: userDefaultWorkspace.workspaceId })
      .from(userDefaultWorkspace)
      .where(eq(userDefaultWorkspace.userId, userId))
      .limit(1);

    const [lastActiveWorkspaceMapping] = await ctx.db
      .select({ workspaceId: userLastActiveWorkspace.workspaceId })
      .from(userLastActiveWorkspace)
      .where(eq(userLastActiveWorkspace.userId, userId))
      .limit(1);

    return {
      workspaces: workspaceRows.map((workspaceRow) => ({
        id: workspaceRow.id,
        name: workspaceRow.name,
        description: workspaceRow.description,
        createdAt: workspaceRow.createdAt.toISOString(),
        updatedAt: workspaceRow.updatedAt.toISOString(),
      })),
      defaultWorkspaceId: defaultWorkspaceMapping?.workspaceId ?? null,
      lastActiveWorkspaceId: lastActiveWorkspaceMapping?.workspaceId ?? null,
    };
  }),

  create: protectedProcedure
    .input(workspaceCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const [createdWorkspace] = await ctx.db
        .insert(workspace)
        .values({
          name: input.name,
          description: input.description,
          userId: ctx.auth.user.id,
        })
        .returning();
      if (!createdWorkspace) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create workspace",
        });
      }
      return {
        id: createdWorkspace.id,
        name: createdWorkspace.name,
        description: createdWorkspace.description,
        createdAt: createdWorkspace.createdAt.toISOString(),
        updatedAt: createdWorkspace.updatedAt.toISOString(),
      };
    }),

  // 單純取得預設 workspace（若不存在則回傳 null，不建立）
  getDefault: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.auth.user.id;
    const mapping = await ctx.db
      .select({ workspaceId: userDefaultWorkspace.workspaceId })
      .from(userDefaultWorkspace)
      .where(eq(userDefaultWorkspace.userId, userId))
      .limit(1);

    if (!mapping[0]) return null;

    const [row] = await ctx.db
      .select({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(eq(workspace.id, mapping[0].workspaceId))
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }),

  // 確保存在預設 workspace（不存在才建立）
  ensureDefault: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.auth.user.id;

    // 取得或建立 default workspace 對應
    const defaultWorkspaceMapping = await ctx.db
      .select({ workspaceId: userDefaultWorkspace.workspaceId })
      .from(userDefaultWorkspace)
      .where(eq(userDefaultWorkspace.userId, userId))
      .limit(1);

    let defaultWorkspaceId: string | undefined =
      defaultWorkspaceMapping[0]?.workspaceId;
    if (!defaultWorkspaceId) {
      const userName = ctx.auth.user.name?.trim() ?? "";
      const defaultName =
        userName.length > 0 ? `${userName}'s workspace` : "Default workspace";

      const [createdWorkspace] = await ctx.db
        .insert(workspace)
        .values({
          name: defaultName,
          description: "Default workspace",
          userId,
        })
        .returning();
      if (!createdWorkspace) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create default workspace",
        });
      }

      await ctx.db
        .insert(userDefaultWorkspace)
        .values({ userId, workspaceId: createdWorkspace.id });
      defaultWorkspaceId = createdWorkspace.id;
    }

    // 若尚未有 lastActive，預設為 default workspace（避免競態，使用 DoNothing）
    if (defaultWorkspaceId) {
      await ctx.db
        .insert(userLastActiveWorkspace)
        .values({
          userId,
          workspaceId: defaultWorkspaceId,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: userLastActiveWorkspace.userId });
    }
  }),

  // 取得最後啟用的 workspace（若不存在回傳 null）
  getLastActive: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.auth.user.id;
    const [lastActiveWorkspaceRow] = await ctx.db
      .select({ workspaceId: userLastActiveWorkspace.workspaceId })
      .from(userLastActiveWorkspace)
      .where(eq(userLastActiveWorkspace.userId, userId))
      .limit(1);
    if (!lastActiveWorkspaceRow) return null;

    const [lastActiveWorkspaceRowDetail] = await ctx.db
      .select({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(eq(workspace.id, lastActiveWorkspaceRow.workspaceId))
      .limit(1);
    if (!lastActiveWorkspaceRowDetail) return null;

    return {
      id: lastActiveWorkspaceRowDetail.id,
      name: lastActiveWorkspaceRowDetail.name,
      description: lastActiveWorkspaceRowDetail.description,
      createdAt: lastActiveWorkspaceRowDetail.createdAt.toISOString(),
      updatedAt: lastActiveWorkspaceRowDetail.updatedAt.toISOString(),
    };
  }),

  // 設定最後啟用的 workspace
  setLastActive: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      // 驗證 workspace 歸屬此使用者
      const [owned] = await ctx.db
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.workspaceId))
        .limit(1);
      if (!owned || owned.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invalid workspace",
        });
      }

      // UPSERT by userId（原子化，避免競態）
      await ctx.db
        .insert(userLastActiveWorkspace)
        .values({
          userId,
          workspaceId: input.workspaceId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userLastActiveWorkspace.userId,
          set: { workspaceId: input.workspaceId, updatedAt: new Date() },
        });
    }),

  // 更新 workspace 名稱/描述（僅限本人）
  update: protectedProcedure
    .input(workspaceUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      const [owned] = await ctx.db
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.id))
        .limit(1);
      if (!owned || owned.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invalid workspace",
        });
      }

      const [updated] = await ctx.db
        .update(workspace)
        .set({
          name: input.name,
          description: input.description,
          updatedAt: new Date(),
        })
        .where(eq(workspace.id, input.id))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update workspace",
        });
      }

      return {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };
    }),

  // 刪除 workspace（禁止刪除預設 workspace）。同時處理 lastActive 指向。
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      // 驗證歸屬
      const [target] = await ctx.db
        .select({ id: workspace.id, userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.id))
        .limit(1);
      if (!target || target.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invalid workspace",
        });
      }

      // 取預設與最後啟用對應
      const [defaultMapping] = await ctx.db
        .select({ workspaceId: userDefaultWorkspace.workspaceId })
        .from(userDefaultWorkspace)
        .where(eq(userDefaultWorkspace.userId, userId))
        .limit(1);
      const [lastActiveMapping] = await ctx.db
        .select({ workspaceId: userLastActiveWorkspace.workspaceId })
        .from(userLastActiveWorkspace)
        .where(eq(userLastActiveWorkspace.userId, userId))
        .limit(1);

      // 禁止刪除預設 workspace
      if (defaultMapping?.workspaceId === input.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete default workspace",
        });
      }

      // 若 lastActive 指向此 workspace，事先調整
      if (lastActiveMapping?.workspaceId === input.id) {
        if (
          defaultMapping?.workspaceId &&
          defaultMapping.workspaceId !== input.id
        ) {
          await ctx.db
            .insert(userLastActiveWorkspace)
            .values({
              userId,
              workspaceId: defaultMapping.workspaceId,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: userLastActiveWorkspace.userId,
              set: {
                workspaceId: defaultMapping.workspaceId,
                updatedAt: new Date(),
              },
            });
        } else {
          // 若沒有 default 映射，直接刪除 lastActive 記錄以解除限制
          await ctx.db
            .delete(userLastActiveWorkspace)
            .where(eq(userLastActiveWorkspace.userId, userId));
        }
      }

      // 刪除 workspace（會因 scene 的 FK 連動刪除其場景）
      await ctx.db.delete(workspace).where(eq(workspace.id, input.id));

      return { success: true } as const;
    }),
});
