import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { and, eq } from "drizzle-orm";
import { workspace } from "@/server/db/schema";
import { TRPCError } from "@trpc/server";

export const workspaceRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(workspace)
      .where(eq(workspace.userId, ctx.auth.user.id))
      .orderBy(workspace.updatedAt);
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Name is required"),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(workspace)
        .values({
          name: input.name,
          description: input.description,
          userId: ctx.auth.user.id,
        })
        .returning();
      if (!row) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create workspace",
        });
      }
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),

  getOrCreateDefault: protectedProcedure.query(async ({ ctx }) => {
    const userName = ctx.auth.user.name?.trim();
    const displayName = userName && userName.length > 0 ? userName : "Guest";
    const defaultName = `${displayName}'s workspace`;

    const existing = await ctx.db
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.userId, ctx.auth.user.id),
          eq(workspace.name, defaultName),
        ),
      );

    if (existing[0]) {
      const w = existing[0];
      return {
        id: w.id,
        name: w.name,
        description: w.description,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      };
    }

    const [row] = await ctx.db
      .insert(workspace)
      .values({
        name: defaultName,
        description: "Default workspace",
        userId: ctx.auth.user.id,
      })
      .returning();
    if (!row) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create default workspace",
      });
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }),
});
