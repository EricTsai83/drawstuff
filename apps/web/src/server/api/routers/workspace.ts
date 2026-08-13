import { z } from "zod";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@/lib/schemas/workspace";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { and, eq } from "drizzle-orm";
import {
  scene,
  workspace,
  userDefaultWorkspace,
  userLastActiveWorkspace,
} from "@/server/db/schema";
import {
  collectSceneStorageKeys,
  enqueueStorageKeyCleanup,
} from "@/server/storage/reclaim";
import { TRPCError } from "@trpc/server";

export const workspaceRouter = createTRPCRouter({
  getOwned: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const [ownedWorkspace] = await ctx.db
        .select({
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        })
        .from(workspace)
        .where(
          and(
            eq(workspace.id, input.id),
            eq(workspace.userId, ctx.auth.user.id),
          ),
        )
        .limit(1);

      if (!ownedWorkspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      return {
        ...ownedWorkspace,
        createdAt: ownedWorkspace.createdAt.toISOString(),
        updatedAt: ownedWorkspace.updatedAt.toISOString(),
      };
    }),

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

  // 確保存在預設 workspace（不存在才建立）
  ensureDefault: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.auth.user.id;

    await ctx.db.transaction(async (tx) => {
      const [existingMapping] = await tx
        .select({ workspaceId: userDefaultWorkspace.workspaceId })
        .from(userDefaultWorkspace)
        .where(eq(userDefaultWorkspace.userId, userId))
        .limit(1);

      let defaultWorkspaceId = existingMapping?.workspaceId;

      if (!defaultWorkspaceId) {
        const userName = ctx.auth.user.name?.trim() ?? "";
        const defaultName =
          userName.length > 0 ? `${userName}'s workspace` : "Default workspace";

        const [createdWorkspace] = await tx
          .insert(workspace)
          .values({
            name: defaultName,
            description: "Default workspace",
            userId,
          })
          .returning({ id: workspace.id });
        if (!createdWorkspace) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create default workspace",
          });
        }

        await tx
          .insert(userDefaultWorkspace)
          .values({ userId, workspaceId: createdWorkspace.id })
          .onConflictDoNothing({ target: userDefaultWorkspace.userId });

        const [winningMapping] = await tx
          .select({ workspaceId: userDefaultWorkspace.workspaceId })
          .from(userDefaultWorkspace)
          .where(eq(userDefaultWorkspace.userId, userId))
          .limit(1);

        defaultWorkspaceId = winningMapping?.workspaceId;

        if (!defaultWorkspaceId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create default workspace",
          });
        }

        if (defaultWorkspaceId !== createdWorkspace.id) {
          await tx
            .delete(workspace)
            .where(
              and(
                eq(workspace.id, createdWorkspace.id),
                eq(workspace.userId, userId),
              ),
            );
        }
      }

      await tx
        .insert(userLastActiveWorkspace)
        .values({
          userId,
          workspaceId: defaultWorkspaceId,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: userLastActiveWorkspace.userId });
    });
  }),

  // 設定最後啟用的 workspace
  setLastActive: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      // 驗證 workspace 歸屬此使用者
      const [owned] = await ctx.db
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.workspaceId))
        .limit(1);
      if (owned?.userId !== userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
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
      if (owned?.userId !== userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
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
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;

      // 驗證歸屬
      const [target] = await ctx.db
        .select({ id: workspace.id, userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.id))
        .limit(1);
      if (target?.userId !== userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
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

      await ctx.db.transaction(async (tx) => {
        // 若 lastActive 指向此 workspace，事先調整
        if (lastActiveMapping?.workspaceId === input.id) {
          if (
            defaultMapping?.workspaceId &&
            defaultMapping.workspaceId !== input.id
          ) {
            await tx
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
            await tx
              .delete(userLastActiveWorkspace)
              .where(eq(userLastActiveWorkspace.userId, userId));
          }
        }

        // 先鎖 workspace row 再枚舉：move／create scene 進這個 workspace 需要
        // 它的 FOREIGN KEY（KEY SHARE lock），會被 FOR UPDATE 擋住，所以枚舉後
        // 不可能再有 scene 進來、逃過 key 收集。同時重新驗證歸屬。
        const [lockedWorkspace] = await tx
          .select({ id: workspace.id })
          .from(workspace)
          .where(
            and(eq(workspace.id, input.id), eq(workspace.userId, userId)),
          )
          .for("update");
        if (!lockedWorkspace) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workspace not found",
          });
        }

        // 刪除 workspace 會 cascade 掉場景與其 file_record／room／asset 列；
        // storage 物件的 key 必須在同一個 transaction 內進 cleanup outbox，
        // 否則 row 一旦刪除就沒有任何指向物件的線索（GC 只掃還存在的 scene）。
        const workspaceScenes = await tx
          .select({ id: scene.id })
          .from(scene)
          .where(eq(scene.workspaceId, input.id))
          .orderBy(scene.id)
          .for("update");
        const keys = await collectSceneStorageKeys(
          tx,
          workspaceScenes.map(({ id }) => id),
        );
        await enqueueStorageKeyCleanup(tx, keys, "delete-workspace", {
          workspaceId: input.id,
        });
        await tx.delete(workspace).where(eq(workspace.id, input.id));
      });

      return { success: true } as const;
    }),
});
