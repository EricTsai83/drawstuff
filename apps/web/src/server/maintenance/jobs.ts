import "server-only";

import { eq, inArray, ne } from "drizzle-orm";

import { db } from "@/server/db";
import {
  deferredFileCleanup,
  fileRecord,
  scene,
  user,
} from "@/server/db/schema";
import { QUERIES } from "@/server/db/queries";
import { readReferencedSceneAssetIds } from "@/server/scene/referenced-assets";

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
 * scene document no longer references — the accumulation Plan 16's identity
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
};

/**
 * Bounded queue drain. Replaces the fixed take-50: one run clears a normal
 * backlog (the Plan 16 cleanup left 262 keys waiting ~6 weekly runs), while
 * the task, batch and wall-clock caps keep it finite. Runs last so keys
 * enqueued by earlier jobs in the same run are processed immediately.
 */
export function createQueueDrainJob(
  options: QueueDrainOptions = {},
): MaintenanceJob {
  const { batchSize = 50, maxTasks = 500, budgetMs = 60_000 } = options;
  return {
    name: "drain-cleanup-queue",
    run: async (deps) => {
      const startedAtMs = deps.now().getTime();
      const budgetSpent = () => deps.now().getTime() - startedAtMs >= budgetMs;
      let processed = 0;
      let rescheduled = 0;
      let failed = 0;
      let exhaustedBudget = false;

      outer: while (processed + rescheduled + failed < maxTasks) {
        if (budgetSpent()) {
          exhaustedBudget = true;
          break;
        }
        const remainingAllowance = maxTasks - (processed + rescheduled + failed);
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
      let deletedObjects = 0;
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
          const assetKeys = new Set([
            ...(await QUERIES.getFileKeysByOwnerIds([candidate.id])),
            ...(await QUERIES.getFileKeysBySceneIds(sceneIds)),
          ]);
          const thumbnailKeys = await QUERIES.getSceneThumbnailKeysByUserIds([
            candidate.id,
          ]);
          account.scenes = sceneIds.length;
          account.assetObjects = assetKeys.size;
          account.thumbnailObjects = thumbnailKeys.length;

          if (params.dryRun) {
            account.status = "dry-run";
            continue;
          }

          for (const key of [...assetKeys, ...thumbnailKeys]) {
            const outcome = await deleteOrEnqueue(deps, key, "delete-user", {
              userId: candidate.id,
            });
            if (outcome === "deleted") deletedObjects += 1;
            else enqueuedObjects += 1;
          }
          await db.delete(user).where(eq(user.id, candidate.id));
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
        ...(params.dryRun ? {} : { deletedObjects, enqueuedObjects }),
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
export function routineMaintenanceJobs(): MaintenanceJob[] {
  return [
    expiredSharedScenesJob,
    createUnreferencedAssetGcJob(),
    expiredSessionsJob,
    expiredVerificationsJob,
    purgeFinishedQueueRowsJob,
    createQueueDrainJob(),
  ];
}
