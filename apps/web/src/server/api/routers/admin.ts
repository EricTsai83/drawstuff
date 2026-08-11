import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import {
  beginAdminAudit,
  completeAdminAudit,
  type AdminAuditAction,
} from "@/server/admin/audit";
import {
  getActiveOperatorGrant,
  grantOperator,
  revokeOperator,
} from "@/server/admin/access";
import { endRoom, retireAccount, retireScene } from "@/server/admin/retirement";
import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
} from "@/server/api/trpc";
import { type Database } from "@/server/collab/rooms";
import {
  adminAuditEvent,
  adminGrant,
  collaborationRoom,
  deferredFileCleanup,
  scene,
  user,
} from "@/server/db/schema";

async function audited<T>(params: {
  db: Database;
  actorUserId: string;
  action: AdminAuditAction;
  targetType: "scene" | "room" | "account";
  targetId: string;
  run: () => Promise<T>;
}): Promise<T> {
  const { run, ...event } = params;
  const auditId = await beginAdminAudit(event);
  try {
    const result = await run();
    await completeAdminAudit({
      db: params.db,
      auditId,
      status: "succeeded",
    });
    return result;
  } catch (error) {
    await completeAdminAudit({
      db: params.db,
      auditId,
      status: "failed",
      error,
    });
    throw error;
  }
}

const notFound = (message: string) =>
  new TRPCError({ code: "NOT_FOUND", message });

export const adminRouter = createTRPCRouter({
  access: protectedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (input.userId !== ctx.auth.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST" });
      }
      return {
        isOperator: Boolean(
          await getActiveOperatorGrant(ctx.db, ctx.auth.user.id),
        ),
      };
    }),
  overview: adminProcedure.query(async ({ ctx }) => {
    const [users, scenes, activeRooms, pendingCleanup] = await Promise.all([
      ctx.db.select({ value: count() }).from(user),
      ctx.db.select({ value: count() }).from(scene),
      ctx.db
        .select({ value: count() })
        .from(collaborationRoom)
        .where(eq(collaborationRoom.status, "active")),
      ctx.db
        .select({ value: count() })
        .from(deferredFileCleanup)
        .where(eq(deferredFileCleanup.status, "pending")),
    ]);

    return {
      userCount: users[0]?.value ?? 0,
      sceneCount: scenes[0]?.value ?? 0,
      activeRoomCount: activeRooms[0]?.value ?? 0,
      pendingCleanupCount: pendingCleanup[0]?.value ?? 0,
    };
  }),
  listUsers: adminProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).default(""),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      const filter = input.search
        ? or(
            ilike(user.name, pattern),
            ilike(user.email, pattern),
            ilike(user.id, pattern),
          )
        : undefined;

      const targetUsers = await ctx.db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          createdAt: user.createdAt,
        })
        .from(user)
        .where(filter)
        .orderBy(desc(user.createdAt), user.id)
        .limit(input.limit);

      const userIds = targetUsers.map(({ id }) => id);
      if (userIds.length === 0) return [];

      const [sceneCounts, activeRoomCounts, activeGrants] = await Promise.all([
        ctx.db
          .select({ userId: scene.userId, value: count() })
          .from(scene)
          .where(inArray(scene.userId, userIds))
          .groupBy(scene.userId),
        ctx.db
          .select({ userId: collaborationRoom.ownerId, value: count() })
          .from(collaborationRoom)
          .where(
            and(
              inArray(collaborationRoom.ownerId, userIds),
              eq(collaborationRoom.status, "active"),
            ),
          )
          .groupBy(collaborationRoom.ownerId),
        ctx.db
          .select({ userId: adminGrant.userId })
          .from(adminGrant)
          .where(
            and(
              inArray(adminGrant.userId, userIds),
              eq(adminGrant.role, "operator"),
              isNull(adminGrant.revokedAt),
            ),
          ),
      ]);
      const scenesByUser = new Map(
        sceneCounts.map(({ userId, value }) => [userId, value]),
      );
      const activeRoomsByUser = new Map(
        activeRoomCounts.map(({ userId, value }) => [userId, value]),
      );
      const operatorIds = new Set(activeGrants.map(({ userId }) => userId));

      return targetUsers.map((target) => ({
        ...target,
        sceneCount: scenesByUser.get(target.id) ?? 0,
        activeRoomCount: activeRoomsByUser.get(target.id) ?? 0,
        isOperator: operatorIds.has(target.id),
      }));
    }),
  getUser: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const target = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
        columns: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!target) throw notFound("Account not found.");

      const [targetScenes, targetRooms, grant] = await Promise.all([
        ctx.db
          .select({
            id: scene.id,
            name: scene.name,
            isArchived: scene.isArchived,
            isPublished: scene.isPublished,
            updatedAt: scene.updatedAt,
          })
          .from(scene)
          .where(eq(scene.userId, input.userId))
          .orderBy(desc(scene.updatedAt))
          .limit(100),
        ctx.db
          .select({
            roomId: collaborationRoom.roomId,
            sceneId: collaborationRoom.sceneId,
            status: collaborationRoom.status,
            expiresAt: collaborationRoom.expiresAt,
            endedAt: collaborationRoom.endedAt,
            updatedAt: collaborationRoom.updatedAt,
          })
          .from(collaborationRoom)
          .where(eq(collaborationRoom.ownerId, input.userId))
          .orderBy(desc(collaborationRoom.updatedAt))
          .limit(100),
        ctx.db.query.adminGrant.findFirst({
          where: and(
            eq(adminGrant.userId, input.userId),
            eq(adminGrant.role, "operator"),
            isNull(adminGrant.revokedAt),
          ),
          columns: {
            userId: true,
            role: true,
            grantSource: true,
            grantedAt: true,
            grantedByUserId: true,
          },
        }),
      ]);

      return { user: target, scenes: targetScenes, rooms: targetRooms, grant };
    }),
  recentAuditEvents: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(({ ctx, input }) =>
      ctx.db
        .select({
          id: adminAuditEvent.id,
          actorUserId: adminAuditEvent.actorUserId,
          actorEmail: user.email,
          action: adminAuditEvent.action,
          targetType: adminAuditEvent.targetType,
          targetId: adminAuditEvent.targetId,
          status: adminAuditEvent.status,
          error: adminAuditEvent.error,
          occurredAt: adminAuditEvent.occurredAt,
          completedAt: adminAuditEvent.completedAt,
        })
        .from(adminAuditEvent)
        .leftJoin(user, eq(adminAuditEvent.actorUserId, user.id))
        .orderBy(desc(adminAuditEvent.occurredAt))
        .limit(input.limit),
    ),
  grantOperator: adminProcedure
    .input(
      z
        .object({ userId: z.string().min(1), confirmUserId: z.string().min(1) })
        .refine((value) => value.userId === value.confirmUserId, {
          message: "Confirmation must match the target user ID.",
          path: ["confirmUserId"],
        }),
    )
    .mutation(({ ctx, input }) =>
      audited({
        db: ctx.db,
        actorUserId: ctx.auth.user.id,
        action: "grant-admin",
        targetType: "account",
        targetId: input.userId,
        run: () =>
          grantOperator({
            db: ctx.db,
            actorUserId: ctx.auth.user.id,
            targetUserId: input.userId,
          }),
      }),
    ),
  revokeOperator: adminProcedure
    .input(
      z
        .object({ userId: z.string().min(1), confirmUserId: z.string().min(1) })
        .refine((value) => value.userId === value.confirmUserId, {
          message: "Confirmation must match the target user ID.",
          path: ["confirmUserId"],
        }),
    )
    .mutation(({ ctx, input }) =>
      audited({
        db: ctx.db,
        actorUserId: ctx.auth.user.id,
        action: "revoke-admin",
        targetType: "account",
        targetId: input.userId,
        run: () =>
          revokeOperator({
            db: ctx.db,
            actorUserId: ctx.auth.user.id,
            targetUserId: input.userId,
          }),
      }),
    ),
  retireScene: adminProcedure
    .input(z.object({ sceneId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await audited({
        db: ctx.db,
        actorUserId: ctx.auth.user.id,
        action: "retire-scene",
        targetType: "scene",
        targetId: input.sceneId,
        run: async () => {
          const outcome = await retireScene({
            db: ctx.db,
            sceneId: input.sceneId,
          });
          if (!outcome.found) throw notFound("Scene not found.");
          return outcome;
        },
      });
      return result;
    }),
  endRoom: adminProcedure
    .input(z.object({ roomId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const result = await audited({
        db: ctx.db,
        actorUserId: ctx.auth.user.id,
        action: "end-room",
        targetType: "room",
        targetId: input.roomId,
        run: async () => {
          const outcome = await endRoom({ db: ctx.db, roomId: input.roomId });
          if (!outcome.found) throw notFound("Room not found.");
          return outcome;
        },
      });
      return result;
    }),
  retireAccount: adminProcedure
    .input(
      z
        .object({ userId: z.string().min(1), confirmUserId: z.string().min(1) })
        .refine((value) => value.userId === value.confirmUserId, {
          message: "Confirmation must match the target user ID.",
          path: ["confirmUserId"],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await audited({
        db: ctx.db,
        actorUserId: ctx.auth.user.id,
        action: "retire-account",
        targetType: "account",
        targetId: input.userId,
        run: async () => {
          if (input.userId === ctx.auth.user.id)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "An administrator cannot retire their own active account.",
            });
          const outcome = await retireAccount({
            db: ctx.db,
            userId: input.userId,
          });
          if (!outcome.found) throw notFound("Account not found.");
          return outcome;
        },
      });
      return result;
    }),
});
