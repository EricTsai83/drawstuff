import "server-only";

import { and, count, desc, eq, lte, min, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "@/env";
import type { Database } from "@/server/collab/rooms";
import { deferredFileCleanup, maintenanceRun } from "@/server/db/schema";

const RUN_HISTORY = 10;
const HEALTH_TIMEOUT_MS = 3_000;

const reportSchema = z
  .object({
    jobs: z
      .array(
        z.object({
          name: z.string(),
          status: z.enum(["ok", "error"]),
          error: z.string().optional(),
          detail: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
  })
  .catch({});

const healthSchema = z.object({
  ok: z.boolean(),
  version: z.object({ id: z.string(), tag: z.string().optional() }),
  ready: z.record(z.string(), z.boolean()),
});

/** Per-job outcomes of a stored run report; empty when unreadable. */
export function parseMaintenanceReport(report: string | null) {
  if (!report) return [];
  try {
    return reportSchema.parse(JSON.parse(report)).jobs ?? [];
  } catch {
    return [];
  }
}

/** The collaboration Worker's public `/healthz`; never throws. */
async function collaborationHealth() {
  try {
    const response = await fetch(new URL("/healthz", env.COLLAB_CONTROL_URL), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: "no-store",
    });
    const parsed = healthSchema.safeParse(await response.json());
    return parsed.success
      ? { reachable: true as const, ...parsed.data }
      : { reachable: false as const, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      reachable: false as const,
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}

/** Recent maintenance runs, the cleanup queue backlog, and Worker health. */
export async function readMaintenanceStatus(db: Database, now = new Date()) {
  const pending = eq(deferredFileCleanup.status, "pending");
  const [runs, backlog, due, health] = await Promise.all([
    db
      .select()
      .from(maintenanceRun)
      .orderBy(desc(maintenanceRun.startedAt))
      .limit(RUN_HISTORY),
    db
      .select({
        reason: deferredFileCleanup.reason,
        count: count(),
        oldestAt: min(deferredFileCleanup.createdAt),
        maxAttempts: sql<number>`max(${deferredFileCleanup.attempts})::int`,
      })
      .from(deferredFileCleanup)
      .where(pending)
      .groupBy(deferredFileCleanup.reason)
      .orderBy(desc(count())),
    db
      .select({ count: count() })
      .from(deferredFileCleanup)
      .where(and(pending, lte(deferredFileCleanup.nextAttemptAt, now))),
    collaborationHealth(),
  ]);

  return {
    runs: runs.map(({ report, ...run }) => ({
      ...run,
      jobs: parseMaintenanceReport(report),
    })),
    backlog: {
      byReason: backlog,
      pending: backlog.reduce((total, row) => total + row.count, 0),
      due: due[0]?.count ?? 0,
    },
    health,
  };
}
