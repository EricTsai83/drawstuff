import { NextResponse } from "next/server";

import { env } from "@/env";
import { drainControlOutbox } from "@/server/collab/control-outbox";
import { db } from "@/server/db";

/**
 * Minute-level drainer for the collaboration control outbox — the repair
 * path when a post-commit synchronous dispatch failed. Deliberately its own
 * schedule: the weekly `/api/maintenance/cleanup` Vercel cron is storage
 * cleanup and must never double as the enforcement repair path.
 *
 * The minute clock is the collaboration Worker's cron trigger
 * (`apps/collaboration-do/src/outbox-drain.ts`), not a Vercel cron — the
 * Vercel deployment stays on the Hobby plan, whose crons are daily-only.
 * Authorization is `COLLAB_OUTBOX_CRON_SECRET`, deliberately not the
 * maintenance route's `CRON_SECRET`: this secret lives in Cloudflare too,
 * and compromising it must yield nothing beyond triggering an idempotent
 * drain. Anything holding it (manual curl included) may drive this
 * endpoint. The worst-case enforcement latency the cadence implies is
 * documented in `docs/performance/collaboration-slo-capacity.md` §10.
 *
 * No advisory lock: claiming uses `FOR UPDATE SKIP LOCKED` plus a lease, so
 * overlapping runs partition the due events instead of duplicating work —
 * and a duplicated delivery would be idempotent anyway.
 */

/**
 * One bounded run: at most `DEFAULT_DRAIN_MAX_EVENTS` claims, each dispatch
 * capped by the 3s control timeout in batches of five, which keeps the run
 * far inside this envelope.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  // 授權：僅接受 Authorization: Bearer <COLLAB_OUTBOX_CRON_SECRET>。secret 未
  // 設定時一律 401（fail closed）：drain 只是延遲，不是安全問題。
  const secret = env.COLLAB_OUTBOX_CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (secret === undefined || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const report = await drainControlOutbox({ db });
  return NextResponse.json(report);
}
