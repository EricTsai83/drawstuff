import { NextResponse } from "next/server";
import postgres from "postgres";
import { UTApi } from "uploadthing/server";
import { z } from "zod";

import { env } from "@/env";
import { bearerTokenMatches } from "@/server/bearer-token";
import {
  createRoomRetentionJob,
  createUnreferencedAssetGcJob,
  createUserPurgeJob,
  MAINTENANCE_LOCK_KEY,
  routineMaintenanceJobs,
  runMaintenanceJobs,
  type MaintenanceJob,
} from "@/server/maintenance/jobs";

/**
 * Maintenance runner. The route owns authorization, job selection and
 * single-flighting; each job owns its work and its own failure (see
 * `@/server/maintenance/jobs`).
 *
 * Two entry points with different capabilities:
 *
 * - GET — what Vercel Cron sends (it only issues GET). Runs exactly the
 *   routine job set; it takes no body, so nothing a GET carries can select
 *   more than that. The user purge is structurally unreachable here.
 * - POST — manual triggers. Same routine set, plus the explicitly confirmed
 *   user purge via the request body.
 *
 * Both require `Authorization: Bearer <CRON_SECRET>`.
 */

/**
 * The queue drain's task cap (1000) is only reachable if the function lives
 * long enough: at one storage round trip per object, the platform default
 * duration would kill the run mid-drain. 300s is within every Vercel plan's
 * Fluid limit; the drain's own wall-clock budget stays below it so the run
 * always ends by reporting, never by being killed.
 */
export const maxDuration = 300;

/**
 * The drain gets an absolute deadline inside the route envelope: however
 * long the jobs before it ran, it must leave this much room for reporting
 * and unlocking rather than letting the platform kill the run mid-flight.
 */
const DRAIN_DEADLINE_MARGIN_MS = 60_000;

function drainDeadline(): Date {
  return new Date(Date.now() + maxDuration * 1000 - DRAIN_DEADLINE_MARGIN_MS);
}

const RequestBodySchema = z.object({
  /**
   * Read-only retention audit: runs only the named jobs in dry-run mode with
   * wide bounds and skips every routine job, so a manual POST can answer
   * "what would retention reclaim right now?" without writing anything.
   */
  audit: z
    .object({
      roomRetention: z.boolean().default(false),
      unreferencedAssetGc: z.boolean().default(false),
    })
    .optional(),
  /**
   * Explicit opt-in to the single-tenant user purge. Never part of a routine
   * run: the cron path (GET) cannot express it, and the job additionally
   * requires the owner email to be restated as confirmation. Defaults to a
   * dry run.
   */
  userPurge: z
    .object({
      confirmKeepOwnerEmail: z.string().email(),
      dryRun: z.boolean().default(true),
    })
    .optional(),
});

function unauthorized(request: Request): NextResponse | null {
  // 授權：僅接受 Authorization: Bearer <CRON_SECRET>
  if (!bearerTokenMatches(request, env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function runUnderLock(jobs: MaintenanceJob[]): Promise<NextResponse> {
  // Single-flight：session advisory lock 需要固定的 PostgreSQL session，所以用
  // 一條走 non-pooled URL 的專用連線。`POSTGRES_URL` 是 transaction-pooling 的
  // pooler host——經過它，lock 與 unlock 可能落在不同的上游 session，鎖既擋不住
  // 並行執行也可能洩漏。
  const lockClient = postgres(env.POSTGRES_URL_NON_POOLING, { max: 1 });
  try {
    const [row] = await lockClient<
      { locked: boolean }[]
    >`select pg_try_advisory_lock(${MAINTENANCE_LOCK_KEY}) as locked`;
    if (!row?.locked) {
      return NextResponse.json({ skipped: "already-running" });
    }
    try {
      const utapi = new UTApi();
      const report = await runMaintenanceJobs(jobs, {
        deleteStorageFile: async (key) => {
          await utapi.deleteFiles([key]);
        },
        now: () => new Date(),
      });
      // 有 job 失敗回 500 讓 cron 監控看得到，但完整報告照附：成功的部分不因
      // 一個失敗被蓋掉。
      return NextResponse.json(report, {
        status: report.failed > 0 ? 500 : 200,
      });
    } finally {
      await lockClient`select pg_advisory_unlock(${MAINTENANCE_LOCK_KEY})`;
    }
  } finally {
    await lockClient.end();
  }
}

export async function GET(request: Request) {
  return (
    unauthorized(request) ??
    (await runUnderLock(
      routineMaintenanceJobs({ drainDeadlineAt: drainDeadline() }),
    ))
  );
}

export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    // 手動觸發可以不帶 body。
  }
  const parsedBody = RequestBodySchema.safeParse(rawBody ?? {});
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid-body" }, { status: 400 });
  }

  if (parsedBody.data.audit) {
    const audit = parsedBody.data.audit;
    return await runUnderLock([
      ...(audit.roomRetention
        ? [
            createRoomRetentionJob({
              dryRun: true,
              maxRooms: 10_000,
              maxAssetObjects: Number.MAX_SAFE_INTEGER,
            }),
          ]
        : []),
      ...(audit.unreferencedAssetGc
        ? [
            createUnreferencedAssetGcJob({
              dryRun: true,
              maxScenes: 10_000,
              maxRecords: 100_000,
            }),
          ]
        : []),
    ]);
  }

  const jobs: MaintenanceJob[] = [];
  if (parsedBody.data.userPurge) {
    jobs.push(
      createUserPurgeJob({
        keepOwnerEmail: env.CLEANUP_OWNER_EMAIL,
        confirmKeepOwnerEmail: parsedBody.data.userPurge.confirmKeepOwnerEmail,
        dryRun: parsedBody.data.userPurge.dryRun,
      }),
    );
  }
  jobs.push(...routineMaintenanceJobs({ drainDeadlineAt: drainDeadline() }));

  return await runUnderLock(jobs);
}
