import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/env";
import { bearerTokenMatches } from "@/server/bearer-token";
import {
  createRoomRetentionJob,
  createUnreferencedAssetGcJob,
  createUserPurgeJob,
  type MaintenanceJob,
} from "@/server/maintenance/jobs";
import {
  routineJobs,
  runMaintenanceUnderLock,
  type MaintenanceTrigger,
} from "@/server/maintenance/run";

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
 * The queue drain's task cap is only reachable if the function lives long
 * enough: at one storage round trip per object, the platform default duration
 * would kill the run mid-drain (see `MAINTENANCE_MAX_DURATION_S`).
 */
export const maxDuration = 300;

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

async function respond(
  jobs: MaintenanceJob[],
  trigger: MaintenanceTrigger,
): Promise<NextResponse> {
  const result = await runMaintenanceUnderLock(jobs, trigger);
  // 有 job 失敗回 500 讓 cron 監控看得到，但完整報告照附：成功的部分不因
  // 一個失敗被蓋掉。
  return NextResponse.json(result, {
    status: !result.skipped && result.failed > 0 ? 500 : 200,
  });
}

export async function GET(request: Request) {
  return unauthorized(request) ?? (await respond(routineJobs(), "cron"));
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
    return await respond(
      [
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
      ],
      "manual",
    );
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
  jobs.push(...routineJobs());

  return await respond(jobs, "manual");
}
