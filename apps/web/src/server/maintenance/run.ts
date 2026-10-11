import "server-only";

import postgres from "postgres";
import { UTApi } from "uploadthing/server";

import { env } from "@/env";
import { db } from "@/server/db";
import { maintenanceRun } from "@/server/db/schema";
import {
  MAINTENANCE_LOCK_KEY,
  routineMaintenanceJobs,
  runMaintenanceJobs,
  type MaintenanceJob,
  type MaintenanceReport,
} from "@/server/maintenance/jobs";

/**
 * Every entry point that runs maintenance (the Vercel cron, a manual POST and
 * the admin console) declares `maxDuration = 300`; the drain gets an absolute
 * deadline inside it so a run always ends by reporting, never by being killed.
 */
const MAINTENANCE_MAX_DURATION_S = 300;
const DRAIN_DEADLINE_MARGIN_MS = 60_000;

function drainDeadline(): Date {
  return new Date(
    Date.now() + MAINTENANCE_MAX_DURATION_S * 1000 - DRAIN_DEADLINE_MARGIN_MS,
  );
}

export const routineJobs = () =>
  routineMaintenanceJobs({ drainDeadlineAt: drainDeadline() });

export type MaintenanceTrigger = "cron" | "manual" | "admin";

export type MaintenanceRunResult =
  | { skipped: "already-running" }
  | (MaintenanceReport & { skipped?: undefined });

/**
 * Runs `jobs` single-flighted under the maintenance advisory lock and records
 * the outcome in `maintenance_run`, whoever triggered it.
 */
export async function runMaintenanceUnderLock(
  jobs: MaintenanceJob[],
  trigger: MaintenanceTrigger,
): Promise<MaintenanceRunResult> {
  const startedAt = new Date();
  // Single-flight：session advisory lock 需要固定的 PostgreSQL session，所以用
  // 一條走 non-pooled URL 的專用連線。`POSTGRES_URL` 是 transaction-pooling 的
  // pooler host——經過它，lock 與 unlock 可能落在不同的上游 session，鎖既擋不住
  // 並行執行也可能洩漏。
  const lockClient = postgres(env.POSTGRES_URL_NON_POOLING, { max: 1 });
  let result: MaintenanceRunResult;
  try {
    const [row] = await lockClient<
      { locked: boolean }[]
    >`select pg_try_advisory_lock(${MAINTENANCE_LOCK_KEY}) as locked`;
    if (!row?.locked) {
      result = { skipped: "already-running" };
    } else {
      try {
        const utapi = new UTApi();
        result = await runMaintenanceJobs(jobs, {
          deleteStorageFile: async (key) => {
            await utapi.deleteFiles([key]);
          },
          now: () => new Date(),
        });
      } finally {
        await lockClient`select pg_advisory_unlock(${MAINTENANCE_LOCK_KEY})`;
      }
    }
  } finally {
    await lockClient.end();
  }
  await recordRun(trigger, startedAt, result);
  return result;
}

async function recordRun(
  trigger: MaintenanceTrigger,
  startedAt: Date,
  result: MaintenanceRunResult,
): Promise<void> {
  try {
    await db.insert(maintenanceRun).values({
      trigger,
      startedAt,
      status: result.skipped
        ? "skipped"
        : result.failed > 0
          ? "failed"
          : "succeeded",
      failedJobs: result.skipped ? 0 : result.failed,
      report: JSON.stringify(result),
    });
  } catch (error) {
    // The run already happened; losing its record must not fail the caller.
    console.error("Failed to record maintenance run:", error);
  }
}
