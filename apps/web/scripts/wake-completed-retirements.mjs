/**
 * One-time plan 21 deploy step: wakes every completed retirement's Lifecycle
 * Object once, so retirements that finished before release times existed
 * schedule their own storage release (1 h after waking). Dry run by default.
 *
 *   COLLAB_WAKE_DATABASE_URL=… COLLAB_CONTROL_URL=https://… \
 *   COLLAB_AUTHORITY_SECRET=… pnpm collaboration:wake-retirements [--apply]
 *
 * Reads only the retired lifecycle rows; never reads an application database
 * URL implicitly and never changes the database.
 */
import postgres from "postgres";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.COLLAB_WAKE_DATABASE_URL;
const controlUrl = process.env.COLLAB_CONTROL_URL;
const secret = process.env.COLLAB_AUTHORITY_SECRET;
if (!databaseUrl || !controlUrl || !secret) {
  console.error(
    "Set COLLAB_WAKE_DATABASE_URL, COLLAB_CONTROL_URL and COLLAB_AUTHORITY_SECRET.",
  );
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  const rows = await sql`
    SELECT kind, subject, scene_id, operation_id
    FROM drawstuff_collaboration_lifecycle_subject
    WHERE retired AND operation_id IS NOT NULL
    ORDER BY scope`;
  console.log(`${rows.length} completed retirement(s).`);
  let woken = 0;
  for (const row of rows) {
    const target =
      row.kind === "account"
        ? { kind: "account", subject: row.subject }
        : { kind: "scene", subject: row.subject, sceneId: row.scene_id };
    if (!apply) continue;
    const response = await fetch(new URL("/v1/lifecycle", controlUrl), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "query",
        target,
        operationId: row.operation_id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    // 404: already released (or never began here) — nothing left to wake.
    if (!response.ok && response.status !== 404)
      throw new Error(`Lifecycle query answered ${response.status}`);
    woken += 1;
  }
  console.log(
    apply
      ? `Woke ${woken} Lifecycle Object(s); each releases its storage 1 h from now.`
      : "Dry run: re-run with --apply to wake them.",
  );
} finally {
  await sql.end();
}
