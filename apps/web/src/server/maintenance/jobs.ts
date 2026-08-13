import "server-only";

import { and, eq, exists, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  collaborationAsset,
  collaborationRoom,
  collaborationSnapshot,
  deferredFileCleanup,
  fileRecord,
  scene,
  user,
} from "@/server/db/schema";
import { QUERIES } from "@/server/db/queries";
import { lockRoom } from "@/server/collab/rooms";
import { readReferencedSceneAssetIds } from "@/server/scene/referenced-assets";
import {
  collectUserStorageKeys,
  enqueueStorageKeyCleanup,
} from "@/server/storage/reclaim";

/**
 * Maintenance work as named jobs. Each job owns exactly one responsibility and
 * its own failure: the runner catches per job, so one broken step can no
 * longer stop every step queued behind it (the old single-try handler let a
 * failure in the first step silently skip the rest — including the queue that
 * asset deletion depends on).
 *
 * Ordering contract: every job that can enqueue deferred deletions must run
 * before the queue drain, and the drain reads the queue at the moment it
 * runs — keys enqueued earlier in the same run are processed in that run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Advisory lock key for single-flighting the whole maintenance run. */
export const MAINTENANCE_LOCK_KEY = 727_431_601;

export type JobDetail = Record<string, unknown>;

export type JobOutcome =
  | { name: string; status: "ok"; detail: JobDetail }
  | { name: string; status: "error"; error: string; detail?: JobDetail };

/**
 * A job failure that still has partial results worth reporting — thrown so the
 * runner marks the job failed without discarding what did happen (e.g. which
 * accounts a purge already deleted before a later one threw).
 */
export class MaintenanceJobError extends Error {
  constructor(
    message: string,
    readonly detail: JobDetail,
  ) {
    super(message);
  }
}

export type MaintenanceDeps = {
  /** Deletes one storage object; throws when the provider refuses. */
  deleteStorageFile: (key: string) => Promise<void>;
  now: () => Date;
};

export type MaintenanceJob = {
  name: string;
  run: (deps: MaintenanceDeps) => Promise<JobDetail>;
};

export type MaintenanceReport = {
  jobs: JobOutcome[];
  failed: number;
};

export async function runMaintenanceJobs(
  jobs: readonly MaintenanceJob[],
  deps: MaintenanceDeps,
): Promise<MaintenanceReport> {
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) {
    try {
      outcomes.push({
        name: job.name,
        status: "ok",
        detail: await job.run(deps),
      });
    } catch (error) {
      console.error(`Maintenance job failed: ${job.name}`, error);
      outcomes.push({
        name: job.name,
        status: "error",
        error: String(error),
        ...(error instanceof MaintenanceJobError
          ? { detail: error.detail }
          : {}),
      });
    }
  }
  return {
    jobs: outcomes,
    failed: outcomes.filter((outcome) => outcome.status === "error").length,
  };
}

/** Storage delete with the standing fallback: enqueue for the drain to retry. */
async function deleteOrEnqueue(
  deps: MaintenanceDeps,
  key: string,
  reason: string,
  context: Record<string, unknown>,
): Promise<"deleted" | "enqueued"> {
  try {
    await deps.deleteStorageFile(key);
    return "deleted";
  } catch {
    await QUERIES.enqueueDeferredCleanup({ utFileKey: key, reason, context });
    return "enqueued";
  }
}

export const expiredSharedScenesJob: MaintenanceJob = {
  name: "expired-shared-scenes",
  run: async (deps) => {
    const cutoff = new Date(deps.now().getTime() - 30 * DAY_MS);
    const ids = await QUERIES.getSharedSceneIdsOlderThan(cutoff);
    const files = await QUERIES.getFileRecordsBySharedSceneIds(ids);
    let deletedObjects = 0;
    let enqueuedObjects = 0;
    for (const file of files) {
      const outcome = await deleteOrEnqueue(
        deps,
        file.utFileKey,
        "sharedScene_expired",
        { sharedSceneId: file.sharedSceneId },
      );
      if (outcome === "deleted") deletedObjects += 1;
      else enqueuedObjects += 1;
    }
    const deleted = await QUERIES.deleteSharedScenesOlderThan(cutoff);
    return {
      deletedSharedScenes: deleted.length,
      deletedObjects,
      enqueuedObjects,
    };
  },
};

export const expiredSessionsJob: MaintenanceJob = {
  name: "expired-sessions",
  run: async (deps) => {
    const deleted = await QUERIES.deleteExpiredSessions(deps.now());
    return { deletedSessions: deleted.length };
  },
};

export const expiredVerificationsJob: MaintenanceJob = {
  name: "expired-verifications",
  run: async (deps) => {
    const deleted = await QUERIES.deleteExpiredVerifications(deps.now());
    return { deletedVerifications: deleted.length };
  },
};

export const purgeFinishedQueueRowsJob: MaintenanceJob = {
  name: "purge-finished-queue-rows",
  run: async (deps) => {
    const cutoff = new Date(deps.now().getTime() - 30 * DAY_MS);
    const purged = await QUERIES.purgeDeferredFileCleanupOlderThan(cutoff, [
      "done",
      "failed",
    ]);
    return { purgedRows: purged.length };
  },
};

export type UnreferencedAssetGcOptions = {
  /** Scenes inspected per run. */
  maxScenes?: number;
  /** Records reclaimed per run. */
  maxRecords?: number;
  /**
   * Records younger than this are left alone. A fresh record is usually an
   * in-flight save that has uploaded but not yet committed the document; the
   * save-time validation makes deleting one recoverable, but skipping it
   * avoids failing that save at all.
   */
  graceMs?: number;
};

/**
 * Reclaims `file_record` rows (and their storage objects) that the committed
 * scene document no longer references — the accumulation that canonical asset identity
 * change surfaced. Shares `readReferencedSceneAssetIds` with save-time
 * validation and aborted-save cleanup so "referenced" has exactly one meaning,
 * and takes the same scene row lock so it serializes with both.
 *
 * The storage keys of reclaimed records are enqueued to the deferred-cleanup
 * queue **inside the same transaction** that deletes the records: after the
 * commit the record row is gone, so the queue row is the only durable pointer
 * to the object. The drain job — always ordered after this one — deletes the
 * objects in the same run. Deleting inline here instead would lose every
 * not-yet-deleted key if the process died between the commit and the delete.
 *
 * Bounded (scenes, records) and idempotent: a rerun after a full sweep finds
 * nothing to delete.
 */
export function createUnreferencedAssetGcJob(
  options: UnreferencedAssetGcOptions = {},
): MaintenanceJob {
  const { maxScenes = 200, maxRecords = 500, graceMs = DAY_MS } = options;
  return {
    name: "unreferenced-asset-gc",
    run: async (deps) => {
      const graceCutoff = new Date(deps.now().getTime() - graceMs);
      // All candidates, shuffled: a bounded run takes a random maxScenes-sized
      // sample, so no scene can sit permanently outside a fixed first batch
      // (referenced records keep their scene in the candidate set forever, so
      // a stable prefix would starve everything behind it).
      const sceneIds = shuffled(await QUERIES.getSceneIdsWithFileRecords());
      const truncatedScenes = sceneIds.length > maxScenes;

      let scenesScanned = 0;
      let unreadableScenes = 0;
      let reclaimedRecords = 0;

      for (const sceneId of sceneIds.slice(0, maxScenes)) {
        if (reclaimedRecords >= maxRecords) break;
        const budget = maxRecords - reclaimedRecords;
        const result = await db.transaction(async (tx) => {
          const [row] = await tx
            .select({ sceneData: scene.sceneData })
            .from(scene)
            .where(eq(scene.id, sceneId))
            .for("update");
          // Scene gone: its records went with it via cascade.
          if (!row) return { reclaimed: 0, unreadable: false };

          const referenced = await readReferencedSceneAssetIds(row.sceneData);
          // Unreadable document: retain everything, same rule as cleanup.
          if (referenced === null) return { reclaimed: 0, unreadable: true };

          const records = await tx
            .select({
              id: fileRecord.id,
              utFileKey: fileRecord.utFileKey,
              excalidrawFileId: fileRecord.excalidrawFileId,
              createdAt: fileRecord.createdAt,
            })
            .from(fileRecord)
            .where(eq(fileRecord.sceneId, sceneId));
          const stale = records
            .filter(
              (record) =>
                !referenced.has(record.excalidrawFileId) &&
                record.createdAt < graceCutoff,
            )
            .slice(0, budget);
          if (stale.length > 0) {
            await tx.delete(fileRecord).where(
              inArray(
                fileRecord.id,
                stale.map((record) => record.id),
              ),
            );
            await tx.insert(deferredFileCleanup).values(
              stale.map((record) => ({
                utFileKey: record.utFileKey,
                reason: "unreferenced-asset-gc",
                context: JSON.stringify({ sceneId }),
                attempts: 0,
                nextAttemptAt: deps.now(),
                status: "pending" as const,
              })),
            );
          }
          return { reclaimed: stale.length, unreadable: false };
        });

        scenesScanned += 1;
        if (result.unreadable) unreadableScenes += 1;
        reclaimedRecords += result.reclaimed;
      }

      return {
        scenesScanned,
        unreadableScenes,
        deletedRecords: reclaimedRecords,
        enqueuedObjects: reclaimedRecords,
        truncated: truncatedScenes || reclaimedRecords >= maxRecords,
      };
    },
  };
}

/** Reason recorded on cleanup tasks room retention schedules. */
export const ROOM_RETENTION_CLEANUP_REASON = "collab-room-retention";

export type RoomRetentionOptions = {
  /**
   * How long a room must have been ended or expired before its durable data
   * is reclaimed. Never immediate: room TTLs top out at 24h, so a room that
   * left its live window a week ago cannot be one somebody is still using —
   * while a freshly expired room may be seconds away from its owner
   * refreshing it back to life.
   */
  graceMs?: number;
  /** Rooms reclaimed per run. */
  maxRooms?: number;
  /**
   * Asset objects enqueued per run. The drain that runs after this job is
   * itself bounded (`maxTasks` defaults to 500), so a run must not enqueue
   * more than the same run's drain can take — otherwise reclaimed objects sit
   * in the queue for weeks of weekly crons, recreating the producer/drain mismatch this job fixed.
   * The default leaves the drain headroom for other jobs' enqueues.
   */
  maxAssetObjects?: number;
};

/**
 * Reclaims the durable data of rooms that ended or expired past the grace
 * period: generations retire within a room, but nothing
 * ever retired the room itself, so snapshots (Postgres ciphertext) and asset
 * objects (storage) accumulated at the rate rooms were opened.
 *
 * Snapshot rows are deleted outright — the ciphertext lives in the row.
 * Asset rows are deleted with their storage keys enqueued to the deferred
 * cleanup queue **in the same transaction**: after the commit the row is the
 * only pointer to the object, so the queue row must exist before it. The
 * drain job, always ordered after this one, deletes the objects in the run.
 *
 * An expired room that is still `active` is flipped to `ended` first, in the
 * same transaction under the room lock: the create mutation refreshes an
 * expired-but-active room back to life (same roomId, same generation), and a
 * room resurrected after its baseline and assets were reclaimed would greet
 * rejoining members with nothing. Ending it makes create open a fresh room
 * instead. No auth revision bump or relay push is needed — tokens carry the
 * room expiry, so every session and token died with the room days ago. The
 * room row itself stays, as history (unchanged from the end mutation).
 *
 * Eligibility is re-checked under the lock: between the candidate query and
 * the lock, the owner may have refreshed the room.
 *
 * Bounded (rooms and enqueued objects per run, sized to the same run's drain
 * capacity) and idempotent: an ended room is a candidate only while it still
 * holds data, and an expired room stops being one the moment it is ended, so
 * a rerun after a full sweep finds nothing.
 */
export function createRoomRetentionJob(
  options: RoomRetentionOptions = {},
): MaintenanceJob {
  const {
    graceMs = 7 * DAY_MS,
    maxRooms = 50,
    maxAssetObjects = 400,
  } = options;
  return {
    name: "collab-room-retention",
    run: async (deps) => {
      const graceCutoff = new Date(deps.now().getTime() - graceMs);
      // Column-typed comparisons only: a Date interpolated into a raw sql``
      // fragment has no column mapping, and the postgres-js driver refuses to
      // serialize it (PGlite in tests happens to accept it).
      const endedPastGrace = and(
        eq(collaborationRoom.status, "ended"),
        or(
          lt(collaborationRoom.endedAt, graceCutoff),
          and(
            isNull(collaborationRoom.endedAt),
            lt(collaborationRoom.updatedAt, graceCutoff),
          ),
        ),
      );
      const expiredPastGrace = and(
        eq(collaborationRoom.status, "active"),
        lt(collaborationRoom.expiresAt, graceCutoff),
      );
      const holdsData = or(
        exists(
          db
            .select({ one: sql`1` })
            .from(collaborationSnapshot)
            .where(eq(collaborationSnapshot.roomId, collaborationRoom.roomId)),
        ),
        exists(
          db
            .select({ one: sql`1` })
            .from(collaborationAsset)
            .where(eq(collaborationAsset.roomId, collaborationRoom.roomId)),
        ),
      );
      // An expired room is a candidate even with nothing to reclaim: as long
      // as it stays `active` the create mutation can refresh it back to life,
      // so ending it after the grace period is retention work too. An ended
      // room only qualifies while it still holds data (once swept it drops
      // out, which is what keeps reruns idempotent).
      const candidates = await db
        .select({ roomId: collaborationRoom.roomId })
        .from(collaborationRoom)
        .where(or(expiredPastGrace, and(endedPastGrace, holdsData)))
        .limit(maxRooms + 1);
      const truncated = candidates.length > maxRooms;

      let roomsReclaimed = 0;
      let endedExpiredRooms = 0;
      let deletedSnapshots = 0;
      let deletedSnapshotBytes = 0;
      let enqueuedObjects = 0;
      let budgetExhausted = false;

      type ReclaimOutcome =
        | {
            kind: "reclaimed";
            wasExpiredActive: boolean;
            snapshots: number;
            snapshotBytes: number;
            assets: number;
          }
        /** Would push the run past the object budget; left for the next run. */
        | { kind: "deferred" };

      for (const candidate of candidates.slice(0, maxRooms)) {
        if (enqueuedObjects >= maxAssetObjects) {
          budgetExhausted = true;
          break;
        }
        const now = deps.now();
        const outcome = await db.transaction(
          async (tx): Promise<ReclaimOutcome | null> => {
            const room = await lockRoom(tx, candidate.roomId);
            const eligible =
              room !== undefined &&
              (room.status === "ended"
                ? (room.endedAt ?? room.updatedAt) < graceCutoff
                : room.status === "active" && room.expiresAt < graceCutoff);
            if (!eligible) return null;

            // Rooms are reclaimed whole — a half-swept room would defeat the
            // "candidates still hold data" idempotency — so the budget check
            // happens before touching anything. The run's first room may
            // exceed the budget on its own (per-room rows are bounded by the
            // schema's per-generation asset cap); refusing it would starve it
            // forever.
            const [assetTally] = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(collaborationAsset)
              .where(eq(collaborationAsset.roomId, room.roomId));
            const assetCount = assetTally?.count ?? 0;
            if (
              enqueuedObjects > 0 &&
              enqueuedObjects + assetCount > maxAssetObjects
            ) {
              return { kind: "deferred" };
            }

            if (room.status === "active") {
              await tx
                .update(collaborationRoom)
                .set({ status: "ended", endedAt: now, updatedAt: now })
                .where(eq(collaborationRoom.roomId, room.roomId));
            }

            const snapshots = await tx
              .delete(collaborationSnapshot)
              .where(eq(collaborationSnapshot.roomId, room.roomId))
              .returning({ byteLength: collaborationSnapshot.byteLength });
            const assets = await tx
              .delete(collaborationAsset)
              .where(eq(collaborationAsset.roomId, room.roomId))
              .returning({
                utFileKey: collaborationAsset.utFileKey,
                authGeneration: collaborationAsset.authGeneration,
              });
            if (assets.length > 0) {
              await tx.insert(deferredFileCleanup).values(
                assets.map((asset) => ({
                  utFileKey: asset.utFileKey,
                  reason: ROOM_RETENTION_CLEANUP_REASON,
                  context: JSON.stringify({
                    roomId: room.roomId,
                    authGeneration: asset.authGeneration,
                  }),
                  attempts: 0,
                  nextAttemptAt: now,
                  status: "pending" as const,
                })),
              );
            }
            return {
              kind: "reclaimed",
              wasExpiredActive: room.status === "active",
              snapshots: snapshots.length,
              snapshotBytes: snapshots.reduce(
                (total, row) => total + row.byteLength,
                0,
              ),
              assets: assets.length,
            };
          },
        );
        if (!outcome) continue;
        if (outcome.kind === "deferred") {
          budgetExhausted = true;
          break;
        }

        // A data-less expired room is only ended, not "reclaimed".
        if (outcome.snapshots > 0 || outcome.assets > 0) roomsReclaimed += 1;
        if (outcome.wasExpiredActive) endedExpiredRooms += 1;
        deletedSnapshots += outcome.snapshots;
        deletedSnapshotBytes += outcome.snapshotBytes;
        enqueuedObjects += outcome.assets;
      }

      return {
        roomsReclaimed,
        endedExpiredRooms,
        deletedSnapshots,
        deletedSnapshotBytes,
        deletedAssetRows: enqueuedObjects,
        enqueuedObjects,
        truncated: truncated || budgetExhausted,
      };
    },
  };
}

/** Fisher–Yates copy. */
function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export type QueueDrainOptions = {
  batchSize?: number;
  /** Tasks handled per run, successful or not. */
  maxTasks?: number;
  /** Wall-clock budget for the drain. */
  budgetMs?: number;
  /**
   * Absolute cutoff, from the route's execution envelope. The drain always
   * runs last, so however long the jobs before it took, it must stop early
   * enough for the run to report and unlock instead of being killed by the
   * platform. The earlier of this and `budgetMs` wins.
   */
  deadlineAt?: Date;
};

/**
 * Bounded queue drain. Replaces the fixed take-50: one run clears a normal
 * backlog (the historical duplicate cleanup left 262 keys waiting ~6 weekly runs), while
 * the task, batch and wall-clock caps keep it finite. Runs last so keys
 * enqueued by earlier jobs in the same run are processed immediately.
 */
export function createQueueDrainJob(
  options: QueueDrainOptions = {},
): MaintenanceJob {
  const {
    batchSize = 50,
    maxTasks = 500,
    budgetMs = 60_000,
    deadlineAt,
  } = options;
  return {
    name: "drain-cleanup-queue",
    run: async (deps) => {
      const startedAtMs = deps.now().getTime();
      const deadlineMs = Math.min(
        startedAtMs + budgetMs,
        deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
      );
      const budgetSpent = () => deps.now().getTime() >= deadlineMs;
      let processed = 0;
      let rescheduled = 0;
      let failed = 0;
      let exhaustedBudget = false;

      outer: while (processed + rescheduled + failed < maxTasks) {
        if (budgetSpent()) {
          exhaustedBudget = true;
          break;
        }
        const remainingAllowance =
          maxTasks - (processed + rescheduled + failed);
        const tasks = await QUERIES.getDueDeferredCleanups(
          Math.min(batchSize, remainingAllowance),
          deps.now(),
        );
        if (tasks.length === 0) break;
        for (const task of tasks) {
          // Per task, not per batch: one slow storage call must not commit the
          // drain to finishing the other 49 in the batch past the deadline.
          if (budgetSpent()) {
            exhaustedBudget = true;
            break outer;
          }
          try {
            await deps.deleteStorageFile(task.utFileKey);
            await QUERIES.markDeferredCleanupDone(task.id);
            processed += 1;
          } catch (error) {
            const attempts = task.attempts ?? 0;
            if (attempts >= 5) {
              await QUERIES.markDeferredCleanupFailed(task.id, String(error));
              failed += 1;
            } else {
              await QUERIES.rescheduleDeferredCleanup(
                task.id,
                attempts,
                String(error),
              );
              rescheduled += 1;
            }
          }
        }
      }

      // What a capped run leaves behind must be visible, not silent.
      const remaining = await QUERIES.countDueDeferredCleanups(deps.now());
      return { processed, rescheduled, failed, remaining, exhaustedBudget };
    },
  };
}

export type UserPurgeParams = {
  /** The owner to keep, from `CLEANUP_OWNER_EMAIL`. */
  keepOwnerEmail: string;
  /**
   * The caller's confirmation: must restate the owner email exactly. This is
   * the second factor beyond `CRON_SECRET` — the routine cron never sends it,
   * so a scheduled run can never delete users.
   */
  confirmKeepOwnerEmail: string;
  /** Report what would be deleted without writing. */
  dryRun: boolean;
};

/**
 * Single-tenant data reset, not routine maintenance: deletes every user except
 * the owner, per account, with a per-account report. Runs only when the
 * request explicitly asks for it and repeats the owner email as confirmation.
 */
export function createUserPurgeJob(params: UserPurgeParams): MaintenanceJob {
  return {
    name: "purge-non-owner-users",
    run: async (deps) => {
      if (params.confirmKeepOwnerEmail !== params.keepOwnerEmail) {
        throw new Error(
          "confirmation-mismatch: confirmKeepOwnerEmail does not match CLEANUP_OWNER_EMAIL",
        );
      }

      const candidates = await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(ne(user.email, params.keepOwnerEmail));

      const accounts: JobDetail[] = [];
      let enqueuedObjects = 0;
      let failedAccounts = 0;

      // Per candidate, an account either fully reports or fully records its
      // own failure — one broken account must not discard the report of the
      // accounts already purged before it.
      for (const candidate of candidates) {
        const account: JobDetail = {
          userId: candidate.id,
          email: candidate.email,
        };
        accounts.push(account);
        try {
          const sceneIds = await QUERIES.getSceneIdsByUserIds([candidate.id]);
          account.scenes = sceneIds.length;

          if (params.dryRun) {
            const keys = await collectUserStorageKeys(db, candidate.id);
            account.storageObjects = keys.size;
            account.status = "dry-run";
            continue;
          }

          // Same shape as account retirement: every storage key the account
          // holds (asset records, thumbnails, owned-room assets) enters the
          // cleanup outbox in the transaction that cascade-deletes the user,
          // and the drain — ordered after this job — deletes the objects.
          const enqueued = await db.transaction(async (tx) => {
            // Same serialization as account retirement: the user row lock
            // blocks new scenes/rooms/shared scenes landing mid-collection.
            await tx
              .select({ id: user.id })
              .from(user)
              .where(eq(user.id, candidate.id))
              .for("update");
            const keys = await collectUserStorageKeys(tx, candidate.id);
            const count = await enqueueStorageKeyCleanup(
              tx,
              keys,
              "delete-user",
              { userId: candidate.id },
              deps.now(),
            );
            await tx.delete(user).where(eq(user.id, candidate.id));
            return count;
          });
          account.storageObjects = enqueued;
          enqueuedObjects += enqueued;
          account.status = "deleted";
        } catch (error) {
          account.status = "failed";
          account.error = String(error);
          failedAccounts += 1;
        }
      }

      const detail: JobDetail = {
        dryRun: params.dryRun,
        users: accounts.length,
        accounts,
        ...(params.dryRun ? {} : { enqueuedObjects }),
      };
      if (failedAccounts > 0) {
        throw new MaintenanceJobError(
          `user purge failed for ${failedAccounts} account(s)`,
          detail,
        );
      }
      return detail;
    },
  };
}

/**
 * The job set a scheduled run executes. Deliberately excludes the user purge;
 * enqueue-capable jobs come before the drain.
 */
export function routineMaintenanceJobs(
  options: { drainDeadlineAt?: Date } = {},
): MaintenanceJob[] {
  return [
    expiredSharedScenesJob,
    createUnreferencedAssetGcJob(),
    createRoomRetentionJob(),
    expiredSessionsJob,
    expiredVerificationsJob,
    purgeFinishedQueueRowsJob,
    // Sized to the producers' bounded aggregate per-run maximum — 500 from
    // the asset GC plus 512 from room retention's permitted first-room
    // overshoot — with headroom for failure enqueues and backlog, so the
    // task cap alone can never leave a same-run enqueue undrained. The
    // wall-clock budget makes the cap reachable — the default 60s covers
    // nowhere near this many storage round trips — and `deadlineAt` keeps
    // the drain inside the route's execution envelope no matter how long
    // the jobs before it took; whatever gets cut off is reported in
    // `remaining` and picked up next run.
    createQueueDrainJob({
      maxTasks: 1200,
      budgetMs: 180_000,
      deadlineAt: options.drainDeadlineAt,
    }),
  ];
}
