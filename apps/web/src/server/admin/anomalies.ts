import "server-only";

import { and, count, eq, isNull, lt, max, ne, or } from "drizzle-orm";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";

import { applyStorageFence } from "@/server/collab/authority-storage";
import type { Database } from "@/server/collab/rooms";
import {
  collaborationLifecycleSubject,
  collaborationRoom,
  deferredFileCleanup,
} from "@/server/db/schema";
import {
  createRoomRetentionJob,
  roomHoldsData,
} from "@/server/maintenance/jobs";

const HOUR_MS = 60 * 60_000;

/** Owner decisions (2026-10-11): how long each state may last before it needs an operator. */
const ANOMALY_THRESHOLDS = {
  retirementStuckMs: HOUR_MS,
  storageOpenAfterEndMs: HOUR_MS,
  initializationGraceMs: 15 * 60_000,
  endedRoomDataMs: 8 * 24 * HOUR_MS,
} as const;

const ITEM_LIMIT = 50;

/**
 * Everything an operator may need to step in on, computed from Neon only.
 * Each group carries its total, its most recent occurrence, and up to
 * `ITEM_LIMIT` rows (oldest first, the ones waiting longest).
 */
export async function listAdminAnomalies(db: Database, now = new Date()) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const subjects = collaborationLifecycleSubject;
  const rooms = collaborationRoom;

  // Rows frozen before `frozen_at` existed have no time; they are old by now.
  const stuckRetirement = and(
    eq(subjects.frozen, true),
    eq(subjects.retired, false),
    or(
      isNull(subjects.frozenAt),
      lt(subjects.frozenAt, ago(ANOMALY_THRESHOLDS.retirementStuckMs)),
    ),
  );
  const unclosedStorage = and(
    eq(rooms.status, "ended"),
    ne(rooms.storageState, "ended"),
    lt(rooms.endedAt, ago(ANOMALY_THRESHOLDS.storageOpenAfterEndMs)),
  );
  const stuckInitializing = and(
    eq(rooms.status, "initializing"),
    lt(
      rooms.initializationDeadline,
      ago(ANOMALY_THRESHOLDS.initializationGraceMs),
    ),
  );
  const endedWithData = and(
    eq(rooms.status, "ended"),
    lt(rooms.endedAt, ago(ANOMALY_THRESHOLDS.endedRoomDataMs)),
    roomHoldsData(),
  );
  const failedCleanup = eq(deferredFileCleanup.status, "failed");

  const roomItem = {
    roomId: rooms.roomId,
    ownerId: rooms.ownerId,
    storageState: rooms.storageState,
    initializationDeadline: rooms.initializationDeadline,
    endedAt: rooms.endedAt,
  };

  const [
    retirementSummary,
    retirementItems,
    storageSummary,
    storageItems,
    initializingSummary,
    initializingItems,
    dataSummary,
    dataItems,
    cleanupSummary,
  ] = await Promise.all([
    db
      .select({ count: count(), lastAt: max(subjects.frozenAt) })
      .from(subjects)
      .where(stuckRetirement),
    db
      .select({
        scope: subjects.scope,
        kind: subjects.kind,
        subject: subjects.subject,
        sceneId: subjects.sceneId,
        frozenAt: subjects.frozenAt,
      })
      .from(subjects)
      .where(stuckRetirement)
      .orderBy(subjects.frozenAt)
      .limit(ITEM_LIMIT),
    db
      .select({ count: count(), lastAt: max(rooms.endedAt) })
      .from(rooms)
      .where(unclosedStorage),
    db
      .select(roomItem)
      .from(rooms)
      .where(unclosedStorage)
      .orderBy(rooms.endedAt)
      .limit(ITEM_LIMIT),
    db
      .select({ count: count(), lastAt: max(rooms.initializationDeadline) })
      .from(rooms)
      .where(stuckInitializing),
    db
      .select(roomItem)
      .from(rooms)
      .where(stuckInitializing)
      .orderBy(rooms.initializationDeadline)
      .limit(ITEM_LIMIT),
    db
      .select({ count: count(), lastAt: max(rooms.endedAt) })
      .from(rooms)
      .where(endedWithData),
    db
      .select(roomItem)
      .from(rooms)
      .where(endedWithData)
      .orderBy(rooms.endedAt)
      .limit(ITEM_LIMIT),
    db
      .select({ count: count(), lastAt: max(deferredFileCleanup.updatedAt) })
      .from(deferredFileCleanup)
      .where(failedCleanup),
  ]);

  const summary = (rows: { count: number; lastAt: Date | null }[]) => ({
    count: rows[0]?.count ?? 0,
    lastAt: rows[0]?.lastAt ?? null,
  });

  return {
    stuckRetirements: { ...summary(retirementSummary), items: retirementItems },
    unclosedStorage: { ...summary(storageSummary), items: storageItems },
    stuckInitializing: {
      ...summary(initializingSummary),
      items: initializingItems,
    },
    endedWithData: { ...summary(dataSummary), items: dataItems },
    failedCleanup: summary(cleanupSummary),
  };
}

/**
 * Applies the terminal storage fence an ended room's Object never delivered
 * (or abandoned). The Object refuses commands once ended, so the fence is
 * written here with the room's current epoch, exactly as the adapter would.
 */
export async function closeRoomStorage(db: Database, roomId: string) {
  const room = await db.query.collaborationRoom.findFirst({
    where: eq(collaborationRoom.roomId, roomId),
    columns: { status: true, storageState: true, authorityEpoch: true },
  });
  if (!room) return { found: false as const };
  if (room.status !== "ended" || room.storageState === "ended")
    return { found: true as const, closed: false };
  await applyStorageFence(db, {
    v: 1,
    action: "fence",
    roomId: roomIdSchema.parse(roomId),
    authorityEpoch: room.authorityEpoch,
    state: "ended",
  });
  return { found: true as const, closed: true };
}

/** One routine room-retention pass, with the same per-run room and object caps. */
export async function runRoomRetention() {
  return createRoomRetentionJob().run({
    now: () => new Date(),
    deleteStorageFile: () =>
      Promise.reject(new Error("room retention only enqueues cleanup")),
  });
}
