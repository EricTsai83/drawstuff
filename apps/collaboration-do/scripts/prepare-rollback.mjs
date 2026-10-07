/** Prepare protocol-5 code without crossing the newly provisioned Lifecycle namespace. No remote calls. */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unstable_readConfig } from "wrangler";

if (process.argv.length !== 2) throw new Error("This offline preparation takes no arguments");
const worker = resolve(import.meta.dirname, "..");
const root = resolve(worker, "../..");
const destination = resolve(root, ".local/collaboration-cutover/protocol5-rollback");
await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
// Refuse an existing checkout rather than overwriting an operator's artifact.
execFileSync("git", ["worktree", "add", "--detach", destination, "c6f2044"], { cwd: root, stdio: "inherit" });
const target = resolve(destination, "apps/collaboration-do");
const legacy = unstable_readConfig({ config: resolve(target, "wrangler.jsonc") }, { hideWarnings: true });
await copyFile(resolve(worker, "src/maintenance.ts"), resolve(target, "src/p3-maintenance.ts"));
await writeFile(resolve(target, "src/p3-rollback.ts"), 'export { default, CollaborationRoom } from "./index.ts";\nexport { CollaborationLifecycle } from "./p3-maintenance.ts";\n', { flag: "wx" });
const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: legacy.name,
  main: "src/p3-rollback.ts",
  compatibility_date: legacy.compatibility_date,
  compatibility_flags: legacy.compatibility_flags,
  workers_dev: legacy.workers_dev,
  triggers: legacy.triggers,
  observability: { ...legacy.observability, traces: { enabled: true, head_sampling_rate: 0.01 } },
  exports: { ...legacy.exports, CollaborationLifecycle: { type: "durable-object", storage: "sqlite" } },
  durable_objects: { bindings: [...legacy.durable_objects.bindings, { name: "COLLABORATION_LIFECYCLE", class_name: "CollaborationLifecycle" }] },
  version_metadata: legacy.version_metadata,
  vars: legacy.vars,
  secrets: { required: [...(legacy.secrets.required ?? []), "COLLAB_AUTHORITY_SECRET"] },
};
await writeFile(resolve(target, "wrangler.rollback.jsonc"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
console.log(`Prepared detached protocol-5 rollback worktree: ${destination}`);
console.log("Install its frozen dependencies, generate rollback binding types and dry-run before production. This tool does not deploy or modify a database.");
