/** Explicit read-only production inspection. Never auto-loads an application DB URL. */
import { createJiti } from "jiti";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

const [phase, baseline] = process.argv.slice(2);
if (!["before", "after"].includes(phase) || (phase === "after" && !baseline) || (phase === "before" && baseline) || process.argv.length > 4) {
  console.error("Usage: collaboration:reset-check before | after <before-report.json>");
  process.exit(1);
}
const connectionUrl = process.env.COLLAB_RESET_DATABASE_URL;
if (!connectionUrl) {
  console.error("Set COLLAB_RESET_DATABASE_URL privately; no POSTGRES_URL fallback is used.");
  process.exit(1);
}
const web = resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": resolve(web, "src") } });
const { inspectResetDatabase, compareResetReports, resetReportSchema, ResetCheckError } = await jiti.import(resolve(web, "scripts/collaboration-reset-inspect.ts"));
const schema = await jiti.import(resolve(web, phase === "before" ? "tests/support/legacy-collaboration-schema.ts" : "src/server/db/schema.ts"));
const manifest = (await readFile(resolve(web, "../../docs/deployment/collaboration-reset/manifest.sql"), "utf8"))
  .replace(/--[^\n]*/g, "").split(";").map(statement => statement.trim()).filter(Boolean);
let client;
try {
  const target = new URL(connectionUrl);
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !target.hostname) throw new Error("Invalid target");
  client = postgres(connectionUrl, { max: 1, connect_timeout: 15, connection: { application_name: "drawstuff-cutover-readonly" } });
  const report = await inspectResetDatabase(client, connectionUrl, phase, schema, manifest);
  if (baseline) compareResetReports(resetReportSchema.parse(JSON.parse(await readFile(resolve(baseline), "utf8"))), report);
  const directory = resolve(web, "../../.local/collaboration-cutover");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, `${phase}-${Date.now()}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(`Read-only ${phase} inspection passed. Report: ${file}`);
  console.log("Review constraints/indexes against the SQL artifacts manually; this check validates columns and preservation, not every schema property.");
} catch (error) {
  // Do not echo driver errors: they may contain URI credentials or database values.
  if (error instanceof ResetCheckError) console.error(error.message);
  console.error("Cutover check failed: verify the expected schema, external foreign keys, database access and preservation baseline. Keep maintenance active. No changes were applied.");
  process.exitCode = 1;
} finally {
  await client?.end({ timeout: 5 });
}
