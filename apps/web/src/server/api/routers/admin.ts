import { TRPCError } from "@trpc/server";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import { z } from "zod";

import {
  beginAdminAudit,
  completeAdminAudit,
  type AdminAuditAction,
  type AdminAuditTargetType,
} from "@/server/admin/audit";
import {
  getActiveOperatorGrant,
  grantOperator,
  revokeOperator,
} from "@/server/admin/access";
import {
  closeRoomStorage,
  listAdminAnomalies,
  runRoomRetention,
} from "@/server/admin/anomalies";
import { readMaintenanceStatus } from "@/server/admin/maintenance-status";
import { readOpsControls } from "@/server/admin/ops-controls";
import { readDataRelease } from "@/server/admin/data-release";
import {
  enqueueStorageOrphans,
  scanStorageOrphans,
} from "@/server/storage/orphans";
import { UTApi } from "uploadthing/server";
import {
  deleteSharedLink,
  readRoom,
  readUserFootprint,
  revokeUserSessions,
} from "@/server/admin/investigation";
import { unpublishScene } from "@/server/scene/unpublish";
import { QUOTA_DEFAULTS, writeQuota, type QuotaName } from "@/server/quota";
import { COLLAB_ROOMS_DISABLED_KEY, writeOpsFlag } from "@/server/ops/settings";
import {
  endRoom,
  resumeRetirement,
  retireAccount,
  retireScene,
} from "@/server/admin/retirement";
import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
} from "@/server/api/trpc";
import { roomIdInputSchema, type Database } from "@/server/collab/rooms";
import {
  adminAuditEvent,
  adminGrant,
  collaborationRoom,
  deferredFileCleanup,
  opsSignal,
  scene,
  user,
} from "@/server/db/schema";

/** Runs an operator action between a durable audit begin and its outcome. */
async function audited<T>(
  ctx: { db: Database; auth: { user: { id: string } } },
  target: {
    action: AdminAuditAction;
    targetType: AdminAuditTargetType;
    targetId: string;
  },
  run: () => Promise<T>,
): Promise<T> {
  const auditId = await beginAdminAudit({
    db: ctx.db,
    actorUserId: ctx.auth.user.id,
    ...target,
  });
  try {
    const result = await run();
    await completeAdminAudit({
      db: ctx.db,
      auditId,
      status: "succeeded",
    });
    return result;
  } catch (error) {
    try {
      await completeAdminAudit({
        db: ctx.db,
        auditId,
        status: "failed",
        error,
      });
    } catch (auditError) {
      // 記錄失敗不得蓋掉原始錯誤：caller 要看到的是操作為什麼失敗。
      console.error("Failed to complete admin audit event:", auditError);
    }
    throw error;
  }
}

/** Destructive account actions require the target id typed twice. */
const confirmedUserInput = z
  .object({ userId: z.string().min(1), confirmUserId: z.string().min(1) })
  .refine((value) => value.userId === value.confirmUserId, {
    message: "Confirmation must match the target user ID.",
    path: ["confirmUserId"],
  });

const notFound = (message: string) =>
  new TRPCError({ code: "NOT_FOUND", message });

export const adminRouter = createTRPCRouter({
  // 只回答「呼叫者自己」是否為 operator：身份來自 session，不收也不驗任何
  // caller 提供的 userId。
  access: protectedProcedure.query(async ({ ctx }) => {
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
        .where(inArray(collaborationRoom.status, ["initializing", "ready"])),
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
        operatorsOnly: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      const filter = and(
        input.search
          ? or(
              ilike(user.name, pattern),
              ilike(user.email, pattern),
              ilike(user.id, pattern),
            )
          : undefined,
        input.operatorsOnly
          ? inArray(
              user.id,
              ctx.db
                .select({ id: adminGrant.userId })
                .from(adminGrant)
                .where(
                  and(
                    eq(adminGrant.role, "operator"),
                    isNull(adminGrant.revokedAt),
                  ),
                ),
            )
          : undefined,
      );

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
              inArray(collaborationRoom.status, ["initializing", "ready"]),
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
  anomalies: adminProcedure.query(({ ctx }) => listAdminAnomalies(ctx.db)),
  opsControls: adminProcedure.query(({ ctx }) => readOpsControls(ctx.db)),
  dataRelease: adminProcedure.query(({ ctx }) => readDataRelease(ctx.db)),
  // Read-only, but a mutation: it pages through the storage provider and
  // must only run when an operator asks, never on a refetch.
  scanStorageOrphans: adminProcedure
    .input(z.object({ offset: z.number().int().min(0).default(0) }))
    .mutation(async ({ ctx, input }) => {
      // The full key list stays on the server; the enqueue rescans anyway.
      const scan = await scanStorageOrphans(ctx.db, new UTApi(), input.offset);
      return {
        offset: scan.offset,
        scanned: scan.scanned,
        nextOffset: scan.nextOffset,
        orphans: scan.orphans,
        orphanBytes: scan.orphanBytes,
        sample: scan.sample,
      };
    }),
  userFootprint: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(({ ctx, input }) => readUserFootprint(ctx.db, input.userId)),
  listRooms: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(25),
        cursor: z
          .object({ createdAt: z.date(), roomId: roomIdInputSchema })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { cursor, limit } = input;
      const rows = await ctx.db
        .select({
          roomId: collaborationRoom.roomId,
          label: collaborationRoom.label,
          status: collaborationRoom.status,
          createdAt: collaborationRoom.createdAt,
          ownerName: user.name,
          ownerEmail: user.email,
        })
        .from(collaborationRoom)
        .innerJoin(user, eq(user.id, collaborationRoom.ownerId))
        .where(
          and(
            inArray(collaborationRoom.status, ["initializing", "ready"]),
            cursor
              ? or(
                  lt(collaborationRoom.createdAt, cursor.createdAt),
                  and(
                    eq(collaborationRoom.createdAt, cursor.createdAt),
                    lt(collaborationRoom.roomId, cursor.roomId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(collaborationRoom.createdAt),
          desc(collaborationRoom.roomId),
        )
        .limit(limit + 1);
      const rooms = rows.slice(0, limit);
      const last = rooms.at(-1);
      return {
        rooms,
        nextCursor:
          rows.length > limit && last
            ? { createdAt: last.createdAt, roomId: last.roomId }
            : null,
      };
    }),
  getRoom: adminProcedure
    .input(z.object({ roomId: roomIdInputSchema }))
    .query(({ ctx, input }) => readRoom(ctx.db, input.roomId)),
  maintenanceStatus: adminProcedure.query(({ ctx }) =>
    readMaintenanceStatus(ctx.db),
  ),
  failedCleanups: adminProcedure.query(async ({ ctx }) => {
    const failed = eq(deferredFileCleanup.status, "failed");
    const [total, items] = await Promise.all([
      ctx.db.select({ value: count() }).from(deferredFileCleanup).where(failed),
      ctx.db
        .select({
          id: deferredFileCleanup.id,
          utFileKey: deferredFileCleanup.utFileKey,
          reason: deferredFileCleanup.reason,
          context: deferredFileCleanup.context,
          attempts: deferredFileCleanup.attempts,
          lastError: deferredFileCleanup.lastError,
          updatedAt: deferredFileCleanup.updatedAt,
        })
        .from(deferredFileCleanup)
        .where(failed)
        .orderBy(desc(deferredFileCleanup.updatedAt))
        .limit(50),
    ]);
    return { count: total[0]?.value ?? 0, items };
  }),
  recentAuditEvents: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(30),
        action: z.string().max(64).optional(),
        targetId: z.string().max(200).optional(),
        actorUserId: z.string().max(200).optional(),
      }),
    )
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
        .where(
          and(
            input.action ? eq(adminAuditEvent.action, input.action) : undefined,
            input.targetId
              ? eq(adminAuditEvent.targetId, input.targetId)
              : undefined,
            input.actorUserId
              ? eq(adminAuditEvent.actorUserId, input.actorUserId)
              : undefined,
          ),
        )
        .orderBy(desc(adminAuditEvent.occurredAt))
        .limit(input.limit),
    ),
  grantOperator: adminProcedure
    .input(confirmedUserInput)
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "grant-admin",
          targetType: "account",
          targetId: input.userId,
        },
        () =>
          grantOperator({
            db: ctx.db,
            actorUserId: ctx.auth.user.id,
            targetUserId: input.userId,
          }),
      ),
    ),
  revokeOperator: adminProcedure
    .input(confirmedUserInput)
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "revoke-admin",
          targetType: "account",
          targetId: input.userId,
        },
        () =>
          revokeOperator({
            db: ctx.db,
            actorUserId: ctx.auth.user.id,
            targetUserId: input.userId,
          }),
      ),
    ),
  retireScene: adminProcedure
    .input(z.object({ sceneId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "retire-scene",
          targetType: "scene",
          targetId: input.sceneId,
        },
        async () => {
          const outcome = await retireScene({
            db: ctx.db,
            sceneId: input.sceneId,
          });
          if (!outcome.found) throw notFound("Scene not found.");
          return outcome;
        },
      ),
    ),
  endRoom: adminProcedure
    .input(z.object({ roomId: roomIdInputSchema }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        { action: "end-room", targetType: "room", targetId: input.roomId },
        async () => {
          const outcome = await endRoom({ db: ctx.db, roomId: input.roomId });
          if (!outcome.found) throw notFound("Room not found.");
          return outcome;
        },
      ),
    ),
  retireAccount: adminProcedure
    .input(confirmedUserInput)
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "retire-account",
          targetType: "account",
          targetId: input.userId,
        },
        async () => {
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
      ),
    ),
  // 改回 pending、attempts 歸零，由下一次維護 drain 重新處理；不在這裡直接刪
  // UploadThing，避免與 drain 同時處理同一筆。
  retryFailedCleanup: adminProcedure
    .input(z.object({ target: z.union([z.uuid(), z.literal("all")]) }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "retry-cleanup",
          targetType: "cleanup",
          targetId: input.target,
        },
        async () => {
          const now = new Date();
          const rows = await ctx.db
            .update(deferredFileCleanup)
            .set({
              status: "pending",
              attempts: 0,
              nextAttemptAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(deferredFileCleanup.status, "failed"),
                input.target === "all"
                  ? undefined
                  : eq(deferredFileCleanup.id, input.target),
              ),
            )
            .returning({ id: deferredFileCleanup.id });
          if (input.target !== "all" && rows.length === 0)
            throw notFound("Failed cleanup task not found.");
          return { retried: rows.length };
        },
      ),
    ),
  resumeRetirement: adminProcedure
    .input(z.object({ scope: z.string().min(1).max(160) }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "resume-retirement",
          targetType: input.scope.startsWith("scene:") ? "scene" : "account",
          targetId: input.scope,
        },
        async () => {
          const outcome = await resumeRetirement({
            db: ctx.db,
            scope: input.scope,
          });
          if (!outcome.found) throw notFound("No unfinished retirement.");
          return outcome;
        },
      ),
    ),
  closeRoomStorage: adminProcedure
    .input(z.object({ roomId: roomIdInputSchema }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "close-room-storage",
          targetType: "room",
          targetId: input.roomId,
        },
        async () => {
          const outcome = await closeRoomStorage(ctx.db, input.roomId);
          if (!outcome.found) throw notFound("Room not found.");
          return outcome;
        },
      ),
    ),
  runRoomRetention: adminProcedure.mutation(({ ctx }) =>
    audited(
      ctx,
      {
        action: "run-room-retention",
        targetType: "maintenance",
        targetId: "room-retention",
      },
      runRoomRetention,
    ),
  ),
  setCollabRoomsDisabled: adminProcedure
    .input(z.object({ disabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: input.disabled
            ? "disable-collaboration"
            : "enable-collaboration",
          targetType: "maintenance",
          targetId: COLLAB_ROOMS_DISABLED_KEY,
        },
        async () => {
          await writeOpsFlag(
            COLLAB_ROOMS_DISABLED_KEY,
            input.disabled,
            ctx.auth.user.id,
          );
          return { disabled: input.disabled };
        },
      ),
    ),
  resetOpsSignals: adminProcedure.mutation(({ ctx }) =>
    audited(
      ctx,
      {
        action: "reset-ops-signals",
        targetType: "maintenance",
        targetId: "ops-signals",
      },
      async () => {
        // Resetting clears every counter on purpose.
        const rows = await ctx.db
          .delete(opsSignal)
          .where(isNotNull(opsSignal.name))
          .returning({ name: opsSignal.name });
        return { reset: rows.length };
      },
    ),
  ),
  revokeSessions: adminProcedure
    .input(confirmedUserInput)
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "revoke-sessions",
          targetType: "account",
          targetId: input.userId,
        },
        async () => {
          if (input.userId === ctx.auth.user.id)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Sign yourself out from your own session instead.",
            });
          return revokeUserSessions(ctx.db, input.userId);
        },
      ),
    ),
  unpublishScene: adminProcedure
    .input(z.object({ sceneId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "unpublish-scene",
          targetType: "scene",
          targetId: input.sceneId,
        },
        async () => {
          const outcome = await unpublishScene(ctx.db, input.sceneId);
          if (!outcome) throw notFound("Scene not found.");
          return outcome;
        },
      ),
    ),
  deleteSharedLink: adminProcedure
    .input(z.object({ sharedSceneId: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "delete-shared-link",
          targetType: "shared-scene",
          targetId: input.sharedSceneId,
        },
        async () => {
          const outcome = await deleteSharedLink(ctx.db, input.sharedSceneId);
          if (!outcome.found) throw notFound("Shared link not found.");
          return outcome;
        },
      ),
    ),
  setQuota: adminProcedure
    .input(
      z.object({
        name: z.enum(
          Object.keys(QUOTA_DEFAULTS) as [QuotaName, ...QuotaName[]],
        ),
        value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "set-quota",
          targetType: "maintenance",
          targetId: `quota:${input.name}`,
        },
        async () => {
          await writeQuota(ctx.db, input.name, input.value, ctx.auth.user.id);
          return { name: input.name, value: input.value };
        },
      ),
    ),
  enqueueStorageOrphans: adminProcedure
    .input(z.object({ offset: z.number().int().min(0).default(0) }))
    .mutation(({ ctx, input }) =>
      audited(
        ctx,
        {
          action: "enqueue-storage-orphans",
          targetType: "maintenance",
          targetId: `storage-orphans@${input.offset}`,
        },
        () => enqueueStorageOrphans(ctx.db, new UTApi(), input.offset),
      ),
    ),
});
