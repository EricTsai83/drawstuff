import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getActiveOperatorGrant } from "@/server/admin/access";
import { beginAdminAudit, completeAdminAudit } from "@/server/admin/audit";
import { db } from "@/server/db";
import { routineJobs, runMaintenanceUnderLock } from "@/server/maintenance/run";

/**
 * Runs the routine maintenance set from the admin console. A route rather
 * than a tRPC mutation because a run (with its queue drain) can take minutes:
 * it gets the maintenance duration envelope instead of holding a tRPC batch,
 * and the result is recorded in `maintenance_run` even if the browser leaves.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  // A JSON body forces a CORS preflight, so a cross-site form cannot post here.
  if (request.headers.get("content-type") !== "application/json")
    return NextResponse.json({ error: "unsupported" }, { status: 415 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await getActiveOperatorGrant(db, session.user.id)))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const auditId = await beginAdminAudit({
    db,
    actorUserId: session.user.id,
    action: "run-maintenance",
    targetType: "maintenance",
    targetId: "routine",
  });
  try {
    const result = await runMaintenanceUnderLock(routineJobs(), "admin");
    await completeAdminAudit({
      db,
      auditId,
      status: !result.skipped && result.failed > 0 ? "failed" : "succeeded",
    });
    return NextResponse.json(result);
  } catch (error) {
    await completeAdminAudit({ db, auditId, status: "failed", error });
    throw error;
  }
}
