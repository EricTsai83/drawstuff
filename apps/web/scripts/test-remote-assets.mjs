/** Real protocol-7 provider acceptance; temporary fixtures and cleanup runtime are removed on success. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/server/db/schema.ts";
import { UTApi } from "uploadthing/server";
import { makeSignature } from "better-auth/crypto";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { COLLABORATION_PROTOCOL_VERSION } from "@drawstuff/collaboration/protocol";
import { encodeCollaborationAssetPayload, decodeCollaborationAssetPayload } from "@drawstuff/collaboration/asset";
import { SNAPSHOT_REQUEST_HEADER } from "@drawstuff/collaboration/authority";
import { PERFORMANCE_PROBE_HEADER, readServerTimings } from "@drawstuff/collaboration/performance";
import { runAccessAcceptance, faultRuntimeSource } from "./remote-access-acceptance.mjs";
import { runTypicalHotPerformance } from "./remote-performance-acceptance.mjs";
import { startWorkerTail } from "./remote-worker-observability.mjs";

const workerDir = fileURLToPath(new URL("../../collaboration-do/", import.meta.url));
const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const origin = (value) => {
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password && url.href === `${url.origin}/`, "HTTPS origin required");
  return url.origin;
};
const web = origin(process.argv[2]);
const gateway = origin(process.argv[3]);
const failureInjection = process.argv[4] === "--fail-after-upload";
const retirementMode = process.argv[4] === "--retire-scene" ? "scene" : process.argv[4] === "--retire-account" ? "account" : null;
const accessMode = process.argv[4] === "--access-recovery";
const providerDiagnostic = process.argv[4] === "--performance-provider-diagnostic";
const presignDiagnostic = process.argv[4] === "--performance-presign-diagnostic";
const http2Performance = process.argv[4] === "--performance-http2";
const transportControl = process.argv[4] === "--performance-transport-control";
const fullTransportPerformance = http2Performance || transportControl;
const snapshotDiagnostic = process.argv[4] === "--performance-snapshot-diagnostic" || fullTransportPerformance;
const serverDiagnostic = process.argv[4] === "--performance-server-diagnostic" || presignDiagnostic || snapshotDiagnostic;
const performanceDiagnostic = process.argv[4] === "--performance-typical-hot-diagnostic" || providerDiagnostic || (serverDiagnostic && !fullTransportPerformance);
const performanceMode = process.argv[4] === "--performance-typical-hot" || performanceDiagnostic || fullTransportPerformance;
const reportName = transportControl ? "collaboration-production-3a-transport-control" : http2Performance ? "collaboration-production-3a-http2" : snapshotDiagnostic ? "collaboration-production-3a-snapshot" : presignDiagnostic ? "collaboration-production-3a-presign" : serverDiagnostic ? "collaboration-production-3a-server" : providerDiagnostic ? "collaboration-production-3a-provider" : performanceDiagnostic ? "collaboration-production-3a-diagnostic" : "collaboration-production-3a";
if (performanceMode) await assert.rejects(access(`${rootDir}docs/performance/${reportName}.json`), { code: "ENOENT" }, "Archive the previous report before starting another run");
assert(process.argv.length <= 5 && (!process.argv[4] || failureInjection || retirementMode || accessMode || performanceMode), "Unexpected argument");
assert.equal(gateway, "https://drawstuff-collaboration-do.ericts.workers.dev");
assert.equal(web, "https://draw.ericts.com");
for (const name of ["POSTGRES_URL", "BETTER_AUTH_SECRET", "UPLOADTHING_TOKEN", "COLLAB_IDENTITY_SECRET", "COLLAB_AUTHORITY_SECRET"]) assert(process.env[name], `Missing ${name}`);

async function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { cwd: workerDir, stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
    let output = "";
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-100000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("close", (code) => {
      if (args[1] === "wrangler" && args[2] === "deploy" && !args.includes("--dry-run")) report("worker-deploy-command", { code, version: output.match(/Current Version ID: ([a-f0-9-]+)/)?.[1], uploaded: output.match(/Uploaded ([a-z0-9-]+)/)?.[1], unexpectedDryRun: /dry.run.*exit|exit.*dry.run/i.test(output) });
      code === 0 ? resolve(output) : reject(new Error(`Command failed (${code}): ${args.slice(0, 3).join(" ")}`));
    });
  });
}
const report = (phase, fields = {}) => console.log(JSON.stringify({ phase, ...fields }));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sceneBytes = (scene) => new TextEncoder().encode(JSON.stringify(scene));
const runId = randomUUID();
const subject = `asset-test-${runId}`;
const roomId = `asset-test-${runId}`;
const raceRoomId = `${roomId}-race`;
const roomIds = retirementMode ? [roomId, raceRoomId] : [roomId];
const sceneId = retirementMode === "scene" ? randomUUID() : null;
const guest = { subject: `asset-guest-${runId}`, email: `guest-${runId}@example.invalid`, lifecycleVersion: 1 };
const peer = { subject: `asset-peer-${runId}`, email: `peer-${runId}@example.invalid`, lifecycleVersion: 1 };
const subjects = accessMode ? [subject, guest.subject, peer.subject] : retirementMode || performanceMode ? [subject, guest.subject] : [subject];
const lifecycleScope = retirementMode === "scene" ? `scene:${sceneId}` : retirementMode === "account" ? `account:${subject}` : null;
const email = `${runId}@example.invalid`;
const sessionId = randomUUID();
const sessionToken = randomUUID();
const peerSessionId = randomUUID(), peerSessionToken = randomUUID();
const directory = `${workerDir}.wrangler/asset-acceptance-${runId}`;
const journal = `${rootDir}.local/asset-acceptance-${runId}.json`;
const lock = `${rootDir}.local/asset-acceptance.lock`;
await mkdir(`${rootDir}.local`, { recursive: true });
await writeFile(lock, runId, { mode: 0o600, flag: "wx" });
const sql = postgres(process.env.POSTGRES_URL, { max: 3 });
const db = drizzle(sql, { schema });
const { WebSocket } = createRequire(`${workerDir}package.json`)("ws");
// SDK error logging can include provider URLs. Keep SDK diagnostics out of acceptance logs.
const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN, logLevel: "None" });
const keys = new Set();
let fixtureCreated = false;
let roomAttempted = false;
let maintenanceAttempted = false;
let restored = false;
let testPassed = false;
let cleanupPassed = false;
let lastProofExpires = 0;
let interrupted = false;
let injectedFailure = false;
let retirementStarted = false;
let retirementCompleted = false;
let retirementOperation;
let faultRuntimeActive = false;
let performanceReport;
let workerTail;
const sockets = [];
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; report("interrupt-requested-cleanup-will-run"); });
let cfToken;
let initialBindings;
let normalRuntimeHash;
let initialDeploymentId;
async function cfGet(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/01db0963ee12ab1901ca993a89ac45f8${path}`, { headers: { authorization: `Bearer ${cfToken}` }, signal: AbortSignal.timeout(20000) });
  const data = await response.json(); assert(response.ok && data.success, `Cloudflare HTTP ${response.status}`); return data.result;
}
const settingsPath = "/workers/scripts/drawstuff-collaboration-do/settings";
const sortedBindings = (settings) => settings.bindings.toSorted((a, b) => a.name.localeCompare(b.name));
async function deployedRuntime() {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/01db0963ee12ab1901ca993a89ac45f8/workers/scripts/drawstuff-collaboration-do/content/v2", { headers: { authorization: `Bearer ${cfToken}` }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  const modules = [...(await response.formData()).entries()];
  // This Worker is a single bundled module. Fail before creating fixtures if packaging changes.
  assert.equal(modules.length, 1); assert.equal(modules[0][0], "index.js");
  assert(modules[0][1] instanceof File);
  return new Uint8Array(await modules[0][1].arrayBuffer());
}
async function providerFiles() {
  const files = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const page = await utapi.listFiles({ limit: 500, offset }); files.push(...page.files);
    if (!page.hasMore) return files;
  }
  throw new Error("Provider inventory incomplete");
}
const proof = (identity = { subject, email, lifecycleVersion: 1 }, targetRoomId = roomId) => {
  const now = Math.floor(Date.now() / 1000);
  lastProofExpires = now * 1000 + 60000;
  return signIdentityProof({ v: 1, aud: "drawstuff-room-identity", protocolVersion: COLLABORATION_PROTOCOL_VERSION, jti: randomUUID(), iat: now, exp: now + 60, roomId: targetRoomId, identity }, process.env.COLLAB_IDENTITY_SECRET);
};
const envelope = (targetRoomId = roomId) => ({ v: 1, roomId: targetRoomId, operationId: randomUUID(), deadline: Date.now() + 60000 });
async function jsonPost(path, body, timings, fetchImpl = fetch) {
  const response = await fetchImpl(`${gateway}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, "content-type": "application/json", ...(timings ? { [PERFORMANCE_PROBE_HEADER]: "1" } : {}), ...(path === "/internal/asset-test-cleanup" ? { connection: "close" } : {}) }, body: JSON.stringify(body) });
  if (response.status !== 200) report("gateway-request-refused", { path, http: response.status });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  if(timings) Object.assign(timings,readServerTimings(response.headers.get("server-timing")));
  return response.json();
}
async function settle(request) {
  let result = (await jsonPost("/v1/authority", { proof: proof(), request })).result;
  const deadline = Date.now() + 60000;
  while (result.status === "pending" && Date.now() < deadline) {
    await pause(1000);
    result = (await jsonPost("/v1/authority", { proof: proof(), request: { ...envelope(), action: "query", operationId: request.operationId } })).result;
  }
  assert.equal(result.status, "enforced");
}
async function saveJournal() {
  await mkdir(`${rootDir}.local`, { recursive: true });
  await writeFile(journal, JSON.stringify({ runId, subjects, roomIds, sceneId, lifecycleScope, retirementOperation, sessionId, peerSessionId: accessMode ? peerSessionId : undefined, keys: [...keys], maintenanceAttempted, faultRuntimeActive, restored, normalRuntimeHash, initialBindings }, null, 2), { mode: 0o600 });
}
async function retry(task) {
  for (let attempt = 0; ; attempt++) {
    try { return await task(); } catch (error) { if (attempt === 2) throw error; await pause(2000); }
  }
}
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(200); }
  throw new Error("Acceptance condition timed out");
}
async function connect(identity = { subject, email, lifecycleVersion: 1 }) {
  const ws = new WebSocket(`${gateway.replace(/^http/, "ws")}/v1/rooms/${roomId}/socket`, { headers: { Origin: web } });
  sockets.push(ws); ws.on("error", () => {});
  let closeCode;
  const closed = new Promise((resolve) => ws.once("close", (code) => { closeCode = code; resolve(code); }));
  let joined;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Join timeout")), 15000);
    const done = (error) => { clearTimeout(timer); ws.off("message", message); ws.off("error", failed); ws.off("close", failed); error ? reject(error) : resolve(); };
    const failed = () => done(new Error("Socket refused"));
    const message = (data, binary) => { if (!binary) { const notice = JSON.parse(data.toString()); if (notice.control === "joined") { joined = notice; done(); } } };
    ws.on("message", message); ws.once("error", failed); ws.once("close", failed);
    ws.once("open", () => ws.send(JSON.stringify({ control: "join", protocolVersion: COLLABORATION_PROTOCOL_VERSION, roomId, token: proof(identity) })));
  });
  return { ws, closed, joined, get closeCode() { return closeCode; } };
}
async function restoreRuntime() {
  let restoreStage = "deployment";
  try {
        report("normal-worker-restoring");
        await retry(() => command(["exec", "wrangler", "deploy", `${directory}/restore/index.js`, "--config", "wrangler.jsonc", "--no-bundle", "--keep-vars"]));
        restoreStage = "routes";
        await until(async () => {
          try {
            const response = await fetch(`${gateway}/v1/authority`, { method: "POST", signal: AbortSignal.timeout(20000), headers: { connection: "close" } }); await response.body?.cancel();
            const cleanupRoute = await fetch(`${gateway}/internal/asset-test-cleanup`, { method: "POST", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, connection: "close" } }); await cleanupRoute.body?.cancel();
            const faultRoute = accessMode ? await fetch(`${gateway}/internal/access-test/${runId}/probe`, { method: "POST", headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, connection: "close" }, signal: AbortSignal.timeout(20000) }) : null;
            await faultRoute?.body?.cancel();
            return response.status === 401 && cleanupRoute.status === 404 && (!faultRoute || faultRoute.status === 404);
          } catch { await pause(2000); return false; }
        }, 60000);
        restoreStage = "bindings";
        const auth = JSON.parse(await command(["exec", "wrangler", "auth", "token", "--json"]));
        cfToken = auth.token ?? auth.oauth_token ?? auth.api_token; assert(cfToken);
        await retry(async () => assert.deepEqual(sortedBindings(await cfGet(settingsPath)), initialBindings, "Worker bindings and variables must be restored"));
        restoreStage = "module";
        await retry(async () => assert.equal(digest(await deployedRuntime()), normalRuntimeHash, "Deployed Worker module must exactly match the pre-test backup"));
        restored = true; report("normal-worker-restored");
  } catch (error) { report("restore-unconfirmed", { stage: restoreStage, errorName: error instanceof Error ? error.name : "unknown", recoveryJournal: journal }); throw new Error("runtime-restore-unconfirmed"); }
}
async function retirementEntry() {
  process.env.COLLAB_CONTROL_URL = gateway;
  const { retireAccount, retireScene } = await import("../src/server/admin/retirement.ts");
  return retirementMode === "scene" ? retireScene({ db, sceneId, ownerUserId: subject }) : retireAccount({ db, userId: subject });
}
async function awaitRetirement() {
  const target = retirementMode === "scene" ? { kind: "scene", subject, sceneId } : { kind: "account", subject };
  await until(async () => {
    const result = await jsonPost("/v1/lifecycle", { action: "query", target, operationId: retirementOperation });
    return result.phase === "completed";
  }, 90000);
  retirementCompleted = true;
}
async function verifyRetirement(cookie, fileId, assetBytes) {
  const ownerSocket = await connect(); const guestSocket = await connect(guest);
  const state = (await jsonPost("/v1/authority", { proof: proof(), request: { ...envelope(), action: "get-state" } })).result;
  await until(async () => {
    const [row] = await sql`select projection_version from drawstuff_collaboration_room where room_id=${roomId}`;
    return row?.projection_version >= state.authRevision;
  });
  // Presign while authorized; the actual provider callback will arrive after retirement.
  const lateIntent = { ...envelope(), kind: "asset-finalize", authorityEpoch: state.authorityEpoch, expectedRevision: 0, checksum: digest(assetBytes), excalidrawFileId: fileId, byteLength: assetBytes.byteLength };
  const presign = await fetch(`${web}/api/uploadthing?slug=collaborationAssetUploader&actionType=upload`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { cookie, "content-type": "application/json", "x-uploadthing-version": "7.7.4" }, body: JSON.stringify({ input: lateIntent, files: [{ name: `${runId}.bin`, type: "application/octet-stream", size: assetBytes.byteLength, lastModified: Date.now() }] }) });
  assert.equal(presign.status, 200); const [lateSigned] = await presign.json(); assert.equal(typeof lateSigned.key, "string"); keys.add(lateSigned.key); await saveJournal();
  const snapshot = sceneBytes({ elements: [], appState: {} });
  const operation = { ...envelope(), kind: "snapshot-put", authorityEpoch: state.authorityEpoch, expectedRevision: 1, checksum: digest(snapshot) };
  const write = () => fetch(`${gateway}/v1/snapshot`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, "content-type": "application/octet-stream", [SNAPSHOT_REQUEST_HEADER]: JSON.stringify({ proof: proof(), request: { action: "write", operation } }) }, body: snapshot });
  let unlock;
  const ready = Promise.withResolvers();
  const release = new Promise((resolve) => { unlock = resolve; });
  const held = sql.begin(async (tx) => {
    await tx`select room_id from drawstuff_collaboration_room where room_id=${roomId} for update`;
    const [row] = await tx`select pg_backend_pid() as pid`; ready.resolve(row.pid); await release;
  });
  void held.catch(ready.reject);
  let pendingWrite;
  try {
    const pid = await ready.promise;
    pendingWrite = write().then((response) => ({ response }), () => ({ failed: true }));
    await until(async () => {
      const [row] = await sql`select exists(select 1 from pg_stat_activity a where ${pid} = any(pg_blocking_pids(a.pid))) as blocked`;
      return row.blocked;
    }, 10000);
    retirementStarted = true; await saveJournal();
    const results = await Promise.all([retirementEntry(), retirementEntry()]);
    retirementOperation = results[0].operationId; assert(retirementOperation); assert.equal(results[1].operationId, retirementOperation); await saveJournal();
    await until(async () => {
      const [fence] = await sql`select frozen from drawstuff_collaboration_lifecycle_subject where scope=${lifecycleScope}`; return fence?.frozen;
    });
    const created = await fetch(`${gateway}/v1/authority`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ proof: proof(undefined, raceRoomId), request: { ...envelope(raceRoomId), action: "create", sceneId, label: "Retirement race", linkRole: "none" } }) });
    assert.notEqual(created.status, 200, "Frozen subject must not create a new Room"); await created.body?.cancel();
    await assert.rejects(() => connect(guest));
    await until(() => Promise.resolve(ownerSocket.ws.readyState === WebSocket.CLOSED && guestSocket.ws.readyState === WebSocket.CLOSED));
    const [source] = retirementMode === "scene" ? await sql`select count(*)::int as count from drawstuff_scene where id=${sceneId}` : await sql`select count(*)::int as count from drawstuff_user where id=${subject}`;
    assert.equal(source.count, 1, "Parent deletion must wait for the Room storage fence ACK");
    const target = retirementMode === "scene" ? { kind: "scene", subject, sceneId } : { kind: "account", subject };
    assert.notEqual((await jsonPost("/v1/lifecycle", { action: "query", target, operationId: retirementOperation })).phase, "completed");
    report("retirement-blocked-write-fence", { target: retirementMode, duplicateOperation: true, frozenCreateAndJoinRejected: true, socketsClosedBeforeParentDelete: true });
  } finally { unlock?.(); await held; }
  const writeResult = await pendingWrite;
  await writeResult.response?.body?.cancel();
  // No second begin is needed: the original requests have ended and only the durable alarm advances retirement.
  await awaitRetirement();
  const repeat = await retirementEntry(); assert.equal(repeat.operationId, retirementOperation); assert.equal(repeat.enforcement, "enforced");
  assert(Date.now() < lateIntent.deadline, "Late callback test must use an unexpired presign intent");
  const form = new FormData(); form.append("file", new File([assetBytes], `${runId}.bin`, { type: "application/octet-stream" }));
  const lateUpload = await fetch(lateSigned.url, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(120000), headers: { Range: "bytes=0-", "x-uploadthing-version": "7.7.4" }, body: form });
  assert.equal(lateUpload.status, 200, "Provider must finish the genuine late callback");
  const lateResult = await lateUpload.json();
  assert.equal(lateResult.serverData?.status, "unknown", "Retired Room must not accept a genuine late callback");
  const [orphan] = await sql`select ut_file_key from drawstuff_deferred_file_cleanup where ut_file_key=${lateSigned.key}`;
  assert(orphan, "Late callback must durably schedule unreferenced provider cleanup");
  const deniedWrite = await write(); assert.notEqual(deniedWrite.status, 200); await deniedWrite.body?.cancel();
  await assert.rejects(() => connect());
  const [rows] = await sql`select (select count(*) from drawstuff_collaboration_room where room_id in ${sql(roomIds)}) + (select count(*) from drawstuff_collaboration_asset where room_id=${roomId}) + (select count(*) from drawstuff_collaboration_snapshot where room_id=${roomId}) as count`;
  assert.equal(Number(rows.count), 0);
  const [fence] = await sql`select frozen,retired from drawstuff_collaboration_lifecycle_subject where scope=${lifecycleScope}`; assert(fence?.frozen && fence.retired);
  report("retirement-alarm-and-late-callback-passed", { target: retirementMode, duplicateRetry: true, deletedRoomContent: true, lateWriteAndRejoinRejected: true });
}

try {
  // The cleanup runtime imports local authority code. Refuse concurrent runtime edits.
  const git = spawn("git", ["diff", "--quiet", "HEAD", "--", "apps/collaboration-do", "packages/collaboration"], { cwd: rootDir, stdio: "ignore" });
  assert.equal(await new Promise((resolve, reject) => { git.once("close", resolve); git.once("error", reject); }), 0, "Worker source must match HEAD before remote acceptance");
  await mkdir(directory, { recursive: true });
  // Only this run's name can be cleared, and only after terminal authority/fence ACK.
  const cleaner = `import { timingSafeEqual } from "node:crypto";
import { CollaborationRoomV2 as Room } from "../../src/room.ts";
import { CollaborationLifecycle as Lifecycle } from "../../src/lifecycle.ts";
const roomIds = ${JSON.stringify(roomIds)}, subject = ${JSON.stringify(subject)}, lifecycleScope = ${JSON.stringify(lifecycleScope)};
export class CollaborationRoomV2 extends Room {
  override async alarm():Promise<void> {
    if(roomIds.includes(this.ctx.id.name ?? "")) await this.ctx.storage.deleteAlarm();
    else await super.alarm();
  }
  override async fetch(request: Request): Promise<Response> {
    if (request.url !== "https://internal.invalid/asset-test-cleanup") return super.fetch(request);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!roomIds.includes(this.ctx.id.name ?? "")) return Response.json({cleared:false},{status:409});
      const rows = this.ctx.storage.sql.exec<{owner:string;state:string;authority_epoch:number;fenced_epoch:number}>("SELECT owner,state,authority_epoch,fenced_epoch FROM authority_room").toArray();
      if (rows.length && (rows.length !== 1 || rows[0]!.owner !== subject || rows[0]!.state !== "ended" || rows[0]!.fenced_epoch < rows[0]!.authority_epoch)) return Response.json({cleared:false},{status:409});
      if (this.ctx.getWebSockets().length) return Response.json({cleared:false},{status:409});
      const counts = this.ctx.storage.sql.exec<{normalJobs:number;securityJobs:number;contentReceipts:number;pendingContent:number;managementReceipts:number}>(
        "SELECT (SELECT count(*) FROM authority_work WHERE security=0) AS normalJobs, (SELECT count(*) FROM authority_work WHERE security=1) AS securityJobs, (SELECT count(*) FROM authority_content) AS contentReceipts, (SELECT count(*) FROM authority_content WHERE terminal_at IS NULL) AS pendingContent, (SELECT count(*) FROM authority_results) AS managementReceipts"
      ).one();
      await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); await this.ctx.storage.sync();
      return Response.json({cleared:(await this.ctx.storage.list()).size === 0 && await this.ctx.storage.getAlarm() === null,counts});
    });
  }
}
export class CollaborationLifecycle extends Lifecycle {
  override async alarm():Promise<void> {
    if(lifecycleScope && this.ctx.id.name === lifecycleScope) await this.ctx.storage.deleteAlarm();
    else await super.alarm();
  }
  override async fetch(request:Request):Promise<Response> {
    if(request.url !== "https://internal.invalid/asset-test-cleanup") return new Response(null,{status:404});
    return this.ctx.blockConcurrencyWhile(async()=>{
      if(!lifecycleScope || this.ctx.id.name !== lifecycleScope) return Response.json({cleared:false},{status:409});
      const rows = this.ctx.storage.sql.exec<{command:string;phase:string}>("SELECT command,phase FROM lifecycle_progress").toArray();
      if(rows.length > 1 || rows.some(row=>{
        const command = JSON.parse(row.command) as {target:{kind:string;subject:string;sceneId?:string}};
        const scope = command.target.kind === "scene" ? "scene:"+command.target.sceneId : "account:"+command.target.subject;
        return row.phase !== "completed" || scope !== lifecycleScope || command.target.subject !== subject;
      })) return Response.json({cleared:false},{status:409});
      await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); await this.ctx.storage.sync();
      return Response.json({cleared:(await this.ctx.storage.list()).size === 0 && await this.ctx.storage.getAlarm() === null});
    });
  }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
  const secret = new TextEncoder().encode(env.COLLAB_AUTHORITY_SECRET ?? "");
  const token = new TextEncoder().encode(request.headers.get("authorization")?.replace(/^Bearer /,"") ?? "");
  if(secret.length < 32 || token.length !== secret.length || !timingSafeEqual(secret,token)) return new Response(null,{status:401});
  if(request.method !== "POST" || new URL(request.url).pathname !== "/internal/asset-test-cleanup") return new Response(null,{status:503});
  const roomCounts = [];
  for(const name of roomIds){
    const result = await env.COLLABORATION_ROOM.getByName(name).fetch("https://internal.invalid/asset-test-cleanup");
    if(!result.ok) return Response.json({cleared:false},{status:409});
    const data = await result.json() as {cleared:boolean;counts:Record<string,number>};
    if(!data.cleared) return Response.json({cleared:false},{status:409});
    roomCounts.push(data.counts);
  }
  if(lifecycleScope){
    const result = await env.COLLABORATION_LIFECYCLE.getByName(lifecycleScope).fetch("https://internal.invalid/asset-test-cleanup");
    if(!result.ok || !(await result.json() as {cleared:boolean}).cleared) return Response.json({cleared:false},{status:409});
  }
  return Response.json({cleared:true,roomCounts});
}} satisfies ExportedHandler<Env>;
`;
  await writeFile(`${directory}/cleanup.ts`, cleaner, { mode: 0o600 });
  await writeFile(`${directory}/tsconfig.json`, JSON.stringify({ extends: "../../tsconfig.json", include: ["cleanup.ts", "../../*.ts"], exclude: [] }), { mode: 0o600 });
  await command(["exec", "tsc", "--noEmit", "--project", `${directory}/tsconfig.json`]);
  if (accessMode) {
    await writeFile(`${directory}/fault.ts`, faultRuntimeSource({ roomId, runId, gateway }), { mode: 0o600 });
    await writeFile(`${directory}/tsconfig.json`, JSON.stringify({ extends: "../../tsconfig.json", include: ["fault.ts", "../../*.ts"], exclude: [] }), { mode: 0o600 });
    await command(["exec", "tsc", "--noEmit", "--project", `${directory}/tsconfig.json`]);
    await command(["exec", "wrangler", "deploy", `${directory}/fault.ts`, "--config", "wrangler.jsonc", "--dry-run", "--outdir", `${directory}/fault-check`]);
  }
  await command(["exec", "wrangler", "deploy", `${directory}/cleanup.ts`, "--config", "wrangler.jsonc", "--dry-run", "--outdir", `${directory}/check`]);
  await command(["exec", "wrangler", "deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", `${directory}/restore`]);
  assert((await readFile(`${directory}/restore/index.js`)).byteLength > 0);
  const cfAuth = JSON.parse(await command(["exec", "wrangler", "auth", "token", "--json"]));
  cfToken = cfAuth.token ?? cfAuth.oauth_token ?? cfAuth.api_token; assert(cfToken);
  initialBindings = sortedBindings(await cfGet(settingsPath));
  // Plan 21 moved rooms to a new class (and namespace); pin the class, not a namespace id.
  const roomBinding = initialBindings.find((b) => b.name === "COLLABORATION_ROOM");
  assert.equal(roomBinding?.class_name, "CollaborationRoomV2"); assert.equal(typeof roomBinding.namespace_id, "string");
  assert.equal(initialBindings.find((b) => b.name === "COLLABORATION_LIFECYCLE")?.namespace_id, "789308f282c349b58578e29496dfa502");
  const normalRuntime = await deployedRuntime(); normalRuntimeHash = digest(normalRuntime);
  if (performanceMode) {
    const deployments = await cfGet("/workers/scripts/drawstuff-collaboration-do/deployments");
    initialDeploymentId = deployments.deployments?.[0]?.id;
    assert.equal(typeof initialDeploymentId, "string", "Initial Worker deployment must be identifiable");
  }
  await writeFile(`${directory}/restore/index.js`, normalRuntime, { mode: 0o600 });
  assert(!interrupted, "Acceptance interrupted");
  if (fullTransportPerformance) workerTail = await startWorkerTail({ workerDir, roomIds, report });
  // Save the identifiers before the first external mutation, for recovery after process interruption.
  await saveJournal();
  await sql.begin(async (tx) => {
    await tx`insert into drawstuff_user (id,name,email,email_verified,created_at,updated_at) values (${subject},'Automated asset acceptance',${email},true,now(),now())`;
    await tx`insert into drawstuff_session (id,user_id,token,expires_at,created_at,updated_at) values (${sessionId},${subject},${sessionToken},now()+make_interval(mins => ${performanceMode ? 120 : 15}),now(),now())`;
    if (retirementMode || accessMode || performanceMode) await tx`insert into drawstuff_user (id,name,email,email_verified,created_at,updated_at) values (${guest.subject},'Automated acceptance guest',${guest.email},true,now(),now())`;
    if (accessMode) {
      await tx`insert into drawstuff_user (id,name,email,email_verified,created_at,updated_at) values (${peer.subject},'Automated acceptance peer',${peer.email},true,now(),now())`;
      await tx`insert into drawstuff_session (id,user_id,token,expires_at,created_at,updated_at) values (${peerSessionId},${peer.subject},${peerSessionToken},now()+interval '15 minutes',now(),now())`;
    }
    if (sceneId) await tx`insert into drawstuff_scene (id,name,user_id,last_updated,created_at,updated_at,is_archived) values (${sceneId},'Automated retirement source',${subject},now(),now(),now(),false)`;
  });
  fixtureCreated = true;
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${await makeSignature(sessionToken, process.env.BETTER_AUTH_SECRET)}`)}`;
  const authenticated = await fetch(`${web}/api/auth/get-session`, { headers: { cookie }, redirect: "error", signal: AbortSignal.timeout(20000) });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json())?.user?.id, subject, "Production must recognize the dedicated test session");
  report("authenticated-fixture");
  assert(!interrupted, "Acceptance interrupted");
  roomAttempted = true;
  const create = { ...envelope(), action: "create", sceneId, label: "Automated asset acceptance", linkRole: retirementMode || accessMode || performanceMode ? "editor" : "none" };
  let toolsUncommitted = false;
  if (performanceMode) {
    toolsUncommitted = await new Promise((resolve,reject) => {
      const child=spawn("git",["diff","--quiet","HEAD","--","apps/web/scripts/test-remote-assets.mjs","apps/web/scripts/remote-performance-acceptance.mjs","apps/web/scripts/remote-worker-observability.mjs"],{cwd:rootDir,stdio:"ignore"});
      child.once("error",reject);child.once("close",code=>code===0 || code===1 ? resolve(code===1) : reject(new Error("tool-status-unavailable")));
    });
    // First DO access must originate from the real web service, as in product initialization.
    const response = await fetch(`${web}/api/trpc/collaborationAuthority.execute`, {
      method: "POST", headers: { cookie, origin: web, "content-type": "application/json" },
      body: JSON.stringify({ json: create }), redirect: "error", signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const initial = (await response.json()).result?.data?.json;
    assert(["pending", "enforced"].includes(initial?.status));
    report("production-web-created-fixture-room");
  }
  await settle(create);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const fileId = createHash("sha1").update(Buffer.from(png, "base64")).digest("hex");
  const payload = encodeCollaborationAssetPayload({ roomId, excalidrawFileId: fileId, mimeType: "image/png", dataUrl: `data:image/png;base64,${png}` }); assert(payload.ok);
  const bytes = payload.bytes;
  const intent = { ...envelope(), kind: "asset-finalize", authorityEpoch: 1, expectedRevision: 0, checksum: digest(bytes), excalidrawFileId: fileId, byteLength: bytes.byteLength };
  assert(!interrupted, "Acceptance interrupted");
  const presign = await fetch(`${web}/api/uploadthing?slug=collaborationAssetUploader&actionType=upload`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { cookie, "content-type": "application/json", "x-uploadthing-version": "7.7.4", "x-uploadthing-package": "drawstuff-acceptance" }, body: JSON.stringify({ input: intent, files: [{ name: `${runId}.bin`, type: "application/octet-stream", size: bytes.byteLength, lastModified: Date.now() }] }) });
  assert.equal(presign.status, 200, `presign HTTP ${presign.status}`);
  const signed = await presign.json();
  assert.equal(signed.length, 1);
  assert.equal(typeof signed[0].key, "string"); keys.add(signed[0].key); await saveJournal();
  assert.equal(new URL(signed[0].url).protocol, "https:");
  const form = new FormData(); form.append("file", new File([bytes], `${runId}.bin`, { type: "application/octet-stream" }));
  report("provider-upload-started");
  const uploaded = await fetch(signed[0].url, { method: "PUT", body: form, redirect: "error", headers: { Range: "bytes=0-", "x-uploadthing-version": "7.7.4" }, signal: AbortSignal.timeout(120000) });
  assert.equal(uploaded.status, 200, `provider PUT HTTP ${uploaded.status}`);
  const provider = await uploaded.json();
  assert(!provider.error, "Provider upload failed");
  assert(["written", "pending"].includes(provider.serverData?.status), "Genuine callback must return a finalize result");
  let asset;
  for (let attempt = 0; attempt < 45; attempt++) {
    [asset] = await sql`select ut_file_key,url,byte_length from drawstuff_collaboration_asset where room_id=${roomId} and excalidraw_file_id=${fileId}`;
    if (asset) break;
    await pause(1000);
  }
  assert(asset, "Callback asset was not committed"); assert.equal(asset.ut_file_key, signed[0].key); assert.equal(asset.byte_length, bytes.byteLength);
  const downloaded = await fetch(asset.url, { redirect: "error", signal: AbortSignal.timeout(20000) }); assert.equal(downloaded.status, 200);
  const stored = new Uint8Array(await downloaded.arrayBuffer()); assert.deepEqual(stored, bytes);
  assert(decodeCollaborationAssetPayload(stored, { roomId, excalidrawFileId: fileId }).ok);
  report("real-callback-download-decode-passed");
  if (failureInjection) { injectedFailure = true; report("intentional-failure-after-real-upload"); throw new Error("acceptance failure injection"); }
  assert(!interrupted, "Acceptance interrupted");
  const snapshot = sceneBytes({ elements: [{ type: "image", fileId }], appState: {} });
  const checksum = digest(snapshot);
  const operation = { ...envelope(), kind: "snapshot-put", authorityEpoch: 1, expectedRevision: 0, checksum };
  const saved = await fetch(`${gateway}/v1/snapshot`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, "content-type": "application/octet-stream", [SNAPSHOT_REQUEST_HEADER]: JSON.stringify({ proof: proof(), request: { action: "write", operation } }) }, body: snapshot });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).status, "written");
  await settle({ ...envelope(), action: "complete-initialization", manifest: { revision: 1, checksum, assetIds: [fileId] } });
  if (retirementMode) await verifyRetirement(cookie, fileId, bytes);
  if (accessMode) {
    const peerCookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${peerSessionToken}.${await makeSignature(peerSessionToken, process.env.BETTER_AUTH_SECRET)}`)}`;
    await runAccessAcceptance({ roomId, runId, web, gateway, guest, peer, peerCookie, sceneBytes, fileId, bytes, sql, keys, saveJournal, proof, envelope, jsonPost, settle, connect, until, report,
      deployFault: async () => {
        maintenanceAttempted = true; faultRuntimeActive = true; restored = false; await saveJournal();
        await command(["exec", "wrangler", "deploy", `${directory}/fault.ts`, "--config", "wrangler.jsonc", "--keep-vars"]);
        const auth = JSON.parse(await command(["exec", "wrangler", "auth", "token", "--json"])); cfToken = auth.token ?? auth.oauth_token ?? auth.api_token;
        const response = await fetch("https://api.cloudflare.com/client/v4/accounts/01db0963ee12ab1901ca993a89ac45f8/workers/scripts/drawstuff-collaboration-do/content/v2", { headers: { authorization: `Bearer ${cfToken}` }, signal: AbortSignal.timeout(20000) }); assert.equal(response.status,200);
        const modules = [...(await response.formData()).entries()];
        const scopedRuntimeIncluded = (await Promise.all(modules.map(async ([,file]) => file instanceof File && (await file.text()).includes(`/internal/access-test/${runId}/`)))).some(Boolean);
        report("scoped-fault-deployment-verified", { modules: modules.map(([name]) => name), scopedRuntimeIncluded }); assert(scopedRuntimeIncluded);
      },
    });
  }
  if (performanceMode) {
    const toolSha256 = {
      runner: digest(await readFile(fileURLToPath(import.meta.url))),
      measurement: digest(await readFile(new URL("./remote-performance-acceptance.mjs", import.meta.url))),
      observability: digest(await readFile(new URL("./remote-worker-observability.mjs", import.meta.url))),
    };
    await runTypicalHotPerformance({ roomId, runId, web, gateway, cookie, sceneBytes, guest, keys, saveJournal, proof, envelope, jsonPost, connect, until, report,
      diagnostic: performanceDiagnostic,
      providerDiagnostic,
      serverDiagnostic, presignDiagnostic, snapshotDiagnostic, http2: http2Performance, transportControl, toolsUncommitted,
      interrupted: () => interrupted || Boolean(workerTail?.failed()), observe: value => { value.runtime.toolSha256 = toolSha256; performanceReport = value; },
    });
  }
  testPassed = !performanceMode || (performanceDiagnostic ? performanceReport.completed : performanceReport.gatePassed); report("attachment-initialization-passed");
} catch (error) {
  // Do not log SQL, signed URLs, cookie, provider response, keys or payload bytes.
  const locations = error instanceof Error ? error.stack?.match(/(?:remote-access-acceptance|remote-performance-acceptance|test-remote-assets)\.mjs:\d+:\d+/g)?.slice(0, 4) : undefined;
  report("test-failed", { errorName: error instanceof Error ? error.name : "unknown", locations });
} finally {
  let cleanupStage = "retirement";
  try {
    if (performanceReport) {
      try {
        // Long runs can outlive the token captured at startup. Ask Wrangler
        // for its current credential before checking deployment identity.
        const auth = JSON.parse(await command(["exec", "wrangler", "auth", "token", "--json"]));
        cfToken = auth.token ?? auth.oauth_token ?? auth.api_token; assert(cfToken);
        const deployments = (await cfGet("/workers/scripts/drawstuff-collaboration-do/deployments")).deployments;
        const unchanged = Array.isArray(deployments) && deployments[0]?.id === initialDeploymentId;
        performanceReport.measurementValidity = {
          initialDeploymentId, observedDeploymentId: deployments?.[0]?.id, workerDeploymentUnchanged: unchanged,
          observedAt: new Date().toISOString(),
          limitation: "Compares deployment identity before fixture creation and before cleanup; web deployments are not independently observed.",
        };
        if (!unchanged) { testPassed = false; performanceReport.gatePassed = false; report("performance-worker-deployment-changed"); }
      } catch (error) {
        testPassed = false; performanceReport.gatePassed = false;
        const httpStatus = error instanceof Error ? error.message.match(/^Cloudflare HTTP (\d{3})$/)?.[1] : undefined;
        performanceReport.measurementValidity = { initialDeploymentId, workerDeploymentUnchanged: null, ...(httpStatus ? {httpStatus:Number(httpStatus)} : {}) };
        report("performance-deployment-unverified", httpStatus ? {httpStatus:Number(httpStatus)} : {});
      }
      // Read only owned fixture counts, before terminal retirement changes projection rows.
      try {
        const [counts] = await sql`select (select count(*) from drawstuff_collaboration_asset where room_id=${roomId}) as assets, (select count(*) from drawstuff_collaboration_snapshot where room_id=${roomId}) as snapshots`;
        performanceReport.beforeRetirement = { assets: Number(counts.assets), snapshots: Number(counts.snapshots) };
      } catch { report("fixture-counts-unavailable-cleanup-will-continue"); }
    }
    if (faultRuntimeActive) {
      cleanupStage = "fault-runtime-restoring";
      try {
        await until(async () => {
          try {
            const response = await fetch(`${gateway}/internal/access-test/${runId}/fault-off`, { method: "POST", headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, connection: "close" }, signal: AbortSignal.timeout(20000) });
            if (response.status !== 200) { await response.body?.cancel(); await pause(15000); return false; }
            return (await response.json()).enabled === 0;
          } catch { await pause(15000); return false; }
        }, 180000);
      } catch { report("fault-disable-unconfirmed-normal-runtime-will-still-restore"); }
      await restoreRuntime(); faultRuntimeActive = false; await saveJournal();
    }
    if (retirementStarted && !retirementCompleted) {
      const result = await retirementEntry(); retirementOperation ??= result.operationId; await saveJournal(); await awaitRetirement();
    }
    for (const ws of sockets) ws.terminate();
    cleanupStage = "room-end";
    let ended = !roomAttempted || retirementCompleted;
    if (roomAttempted && !retirementCompleted) {
      try {
        await until(async () => {
          try {
            const state = (await jsonPost("/v1/authority", { proof: proof(), request: { ...envelope(), action: "get-state" } })).result;
            if (state.state === "ended") {
              const [row] = await sql`select authority_epoch from drawstuff_collaboration_room where room_id=${roomId}`;
              return Number(row?.authority_epoch) >= state.authorityEpoch;
            }
            await settle({ ...envelope(), action: "end-room" }); return true;
          } catch (error) {
            if (error instanceof assert.AssertionError && error.actual === 404) {
              const [row] = await sql`select (select count(*) from drawstuff_collaboration_room where room_id=${roomId}) + (select count(*) from drawstuff_collaboration_creation_fence where room_id=${roomId}) as count`;
              if (Number(row.count) === 0) return true;
            }
            await pause(15000); return false;
          }
        }, 180000);
        ended = true;
      }
      catch { report("room-end-unconfirmed-provider-cleanup-will-still-run"); }
    }
    // A lost presign response must not hide this run's uploaded objects.
    cleanupStage = "provider";
    if (fixtureCreated) for (const file of await providerFiles()) if (file.name === `${runId}.bin`) keys.add(file.key);
    await saveJournal();
    for (const key of keys) {
      const deleted = await retry(() => utapi.deleteFiles(key));
      if (!deleted.success) assert(!(await providerFiles()).some(file => file.key === key), "Provider object deletion unconfirmed");
    }
    for (let attempt = 0; keys.size > 0; attempt++) {
      const remaining = (await providerFiles()).filter((file) => keys.has(file.key));
      if (!remaining.length) break;
      assert(attempt < 30, "Provider deletion remains pending"); await pause(2000);
    }
    assert(ended, "Room end must be confirmed before removing its owner");
    cleanupStage = "accounts";
    if (fixtureCreated) for (const id of subjects) await sql`delete from drawstuff_user where id=${id} and email in (${email},${guest.email},${peer.email})`;
    // Expired fixture proofs plus the deleted account prevent delayed requests from recreating authority.
    while (Date.now() < lastProofExpires + 1000) await pause(Math.min(5000, lastProofExpires + 1000 - Date.now()));
    if (roomAttempted) {
      report("temporary-cleanup-runtime-deploying");
      maintenanceAttempted = true; restored = false; await saveJournal();
      cleanupStage = "maintenance-deployment";
      await command(["exec", "wrangler", "deploy", `${directory}/cleanup.ts`, "--config", "wrangler.jsonc", "--keep-vars"]);
      cleanupStage = "durable-storage";
      await until(async () => {
        try {
          const result = await jsonPost("/internal/asset-test-cleanup", {});
          if (result.cleared && performanceReport) performanceReport.afterRetirementBeforeStorageDeletion = {
            roomCounts: result.roomCounts,
            limitation: "Observed after end-room, expired proofs and cleanup deployment; not failure-time queue occupancy.",
          };
          return result.cleared === true;
        }
        catch { await pause(15000); return false; }
      }, 180000);
    }
    cleanupStage = "database";
    await sql.begin(async (tx) => {
      await tx`delete from drawstuff_collaboration_projection_tombstone where room_id in ${tx(roomIds)}`;
      await tx`delete from drawstuff_collaboration_lifecycle_registration where room_id in ${tx(roomIds)}`;
      await tx`delete from drawstuff_collaboration_creation_fence where room_id in ${tx(roomIds)}`;
      await tx`delete from drawstuff_collaboration_lifecycle_subject where subject in ${tx(subjects)}`;
      for (const key of keys) await tx`delete from drawstuff_deferred_file_cleanup where ut_file_key=${key}`;
      const [remaining] = await tx`select (select count(*) from drawstuff_user where id in ${tx(subjects)}) + (select count(*) from drawstuff_session where id in (${sessionId},${peerSessionId})) + (select count(*) from drawstuff_scene where id=${sceneId}) + (select count(*) from drawstuff_collaboration_room where room_id in ${tx(roomIds)}) + (select count(*) from drawstuff_collaboration_asset where room_id in ${tx(roomIds)}) + (select count(*) from drawstuff_collaboration_snapshot where room_id in ${tx(roomIds)}) as count`;
      assert.equal(Number(remaining.count), 0);
    });
    cleanupPassed = true; report("provider-db-do-cleanup-passed");
  } catch (error) { report("cleanup-unconfirmed", { stage: cleanupStage, errorName: error instanceof Error ? error.name : "unknown", recoveryJournal: journal }); }
  finally {
    if (maintenanceAttempted) {
      try { await restoreRuntime(); } catch { /* Recovery journal is retained below. */ }
    } else restored = true;
    await sql.end();
    if (workerTail) {
      const summary = await workerTail.stop();
      if (performanceReport) performanceReport.workerObservability = summary;
      report("worker-tail-stopped", { deliveryConfirmed: summary.deliveryConfirmed, unexpectedExit: summary.unexpectedExit, platformEvents: summary.platformEvents });
    }
    if (cleanupPassed && restored) { await rm(directory, { recursive: true, force: true }); await rm(journal, { force: true }); await rm(lock, { force: true }); }
    else await saveJournal();
  }
}
const expectedFailureHandled = failureInjection && injectedFailure && cleanupPassed && restored;
if (performanceReport) {
  performanceReport.acceptance = { testPassed, cleanupPassed, restored };
  performanceReport.runtime.commit = (await new Promise((resolve, reject) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
    let output="";child.stdout.on("data", chunk=>{output+=chunk.toString();});child.once("error",reject);child.once("close",code=>code===0 ? resolve(output.trim()) : reject(new Error("commit-unavailable")));
  }));
  performanceReport.runtime.normalWorkerSha256 = normalRuntimeHash;
  await writeFile(`${rootDir}docs/performance/${reportName}.json`, JSON.stringify(performanceReport, null, 2)+"\n", { flag: "wx" });
}
report("result", { testPassed, cleanupPassed, restored, expectedFailureHandled });
if ((!testPassed && !expectedFailureHandled) || !cleanupPassed || !restored) process.exitCode = 1;
