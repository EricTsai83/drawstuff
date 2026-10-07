/** Real protocol-6 provider acceptance; temporary fixtures and cleanup runtime are removed on success. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import postgres from "postgres";
import { UTApi } from "uploadthing/server";
import { makeSignature } from "better-auth/crypto";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import { sealRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { createAssetCryptoCodec, encodeCollaborationAssetPayload, decodeCollaborationAssetPayload } from "@drawstuff/collaboration/asset";
import { deriveSnapshotKey, sealCollaborationSnapshot } from "@drawstuff/collaboration/snapshot";
import { SNAPSHOT_REQUEST_HEADER } from "@drawstuff/collaboration/authority";

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
assert(process.argv.length <= 5 && (!process.argv[4] || failureInjection), "Unexpected argument");
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
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Command failed (${code}): ${args.slice(0, 3).join(" ")}`)));
  });
}
const report = (phase, fields = {}) => console.log(JSON.stringify({ phase, ...fields }));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runId = randomUUID();
const subject = `asset-test-${runId}`;
const roomId = `asset-test-${runId}`;
const email = `${runId}@example.invalid`;
const sessionId = randomUUID();
const sessionToken = randomUUID();
const directory = `${workerDir}.wrangler/asset-acceptance-${runId}`;
const journal = `${rootDir}.local/asset-acceptance-${runId}.json`;
const lock = `${rootDir}.local/asset-acceptance.lock`;
await mkdir(`${rootDir}.local`, { recursive: true });
await writeFile(lock, runId, { mode: 0o600, flag: "wx" });
const sql = postgres(process.env.POSTGRES_URL, { max: 1 });
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
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; report("interrupt-requested-cleanup-will-run"); });
let cfToken;
let initialBindings;
let normalRuntimeHash;
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
const proof = () => {
  const now = Math.floor(Date.now() / 1000);
  lastProofExpires = now * 1000 + 60000;
  return signIdentityProof({ v: 1, aud: "drawstuff-room-identity", protocolVersion: 6, jti: randomUUID(), iat: now, exp: now + 60, roomId, identity: { subject, email, lifecycleVersion: 1 } }, process.env.COLLAB_IDENTITY_SECRET);
};
const envelope = () => ({ v: 1, roomId, operationId: randomUUID(), deadline: Date.now() + 60000 });
async function jsonPost(path, body) {
  const response = await fetch(`${gateway}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
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
  await writeFile(journal, JSON.stringify({ runId, subject, roomId, sessionId, keys: [...keys], maintenanceAttempted, restored, normalRuntimeHash }, null, 2), { mode: 0o600 });
}
async function retry(task) {
  for (let attempt = 0; ; attempt++) {
    try { return await task(); } catch (error) { if (attempt === 2) throw error; await pause(2000); }
  }
}

try {
  // The cleanup runtime imports local authority code. Refuse concurrent runtime edits.
  const git = spawn("git", ["diff", "--quiet", "HEAD", "--", "apps/collaboration-do", "packages/collaboration"], { cwd: rootDir, stdio: "ignore" });
  assert.equal(await new Promise((resolve, reject) => { git.once("close", resolve); git.once("error", reject); }), 0, "Worker source must match HEAD before remote acceptance");
  await mkdir(directory, { recursive: true });
  // Only this run's name can be cleared, and only after terminal authority/fence ACK.
  const cleaner = `import { timingSafeEqual } from "node:crypto";
import { CollaborationRoom as Room } from "../../src/room.ts";
export { CollaborationLifecycle } from "../../src/lifecycle.ts";
const roomId = ${JSON.stringify(roomId)}, subject = ${JSON.stringify(subject)};
export class CollaborationRoom extends Room {
  override async fetch(request: Request): Promise<Response> {
    if (request.url !== "https://internal.invalid/asset-test-cleanup") return super.fetch(request);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.id.name !== roomId) return Response.json({cleared:false},{status:409});
      const rows = this.ctx.storage.sql.exec<{owner:string;state:string;authority_epoch:number;fenced_epoch:number}>("SELECT owner,state,authority_epoch,fenced_epoch FROM authority_room").toArray();
      if (rows.length && (rows.length !== 1 || rows[0]!.owner !== subject || rows[0]!.state !== "ended" || rows[0]!.fenced_epoch < rows[0]!.authority_epoch)) return Response.json({cleared:false},{status:409});
      if (this.ctx.getWebSockets().length) return Response.json({cleared:false},{status:409});
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
  return env.COLLABORATION_ROOM.getByName(roomId).fetch("https://internal.invalid/asset-test-cleanup");
}} satisfies ExportedHandler<Env>;
`;
  await writeFile(`${directory}/cleanup.ts`, cleaner, { mode: 0o600 });
  await command(["exec", "wrangler", "deploy", `${directory}/cleanup.ts`, "--config", "wrangler.jsonc", "--dry-run", "--outdir", `${directory}/check`]);
  await command(["exec", "wrangler", "deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", `${directory}/restore`]);
  assert((await readFile(`${directory}/restore/index.js`)).byteLength > 0);
  const cfAuth = JSON.parse(await command(["exec", "wrangler", "auth", "token", "--json"]));
  cfToken = cfAuth.token ?? cfAuth.oauth_token ?? cfAuth.api_token; assert(cfToken);
  initialBindings = sortedBindings(await cfGet(settingsPath));
  assert.equal(initialBindings.find((b) => b.name === "COLLABORATION_ROOM")?.namespace_id, "5f0f6fe2322c4f20b23c08018c9f9c08");
  assert.equal(initialBindings.find((b) => b.name === "COLLABORATION_LIFECYCLE")?.namespace_id, "789308f282c349b58578e29496dfa502");
  const normalRuntime = await deployedRuntime(); normalRuntimeHash = digest(normalRuntime);
  await writeFile(`${directory}/restore/index.js`, normalRuntime, { mode: 0o600 });
  assert(!interrupted, "Acceptance interrupted");
  // Save the identifiers before the first external mutation, for recovery after process interruption.
  await saveJournal();
  await sql.begin(async (tx) => {
    await tx`insert into drawstuff_user (id,name,email,email_verified,created_at,updated_at) values (${subject},'Automated asset acceptance',${email},true,now(),now())`;
    await tx`insert into drawstuff_session (id,user_id,token,expires_at,created_at,updated_at) values (${sessionId},${subject},${sessionToken},now()+interval '15 minutes',now(),now())`;
  });
  fixtureCreated = true;
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${await makeSignature(sessionToken, process.env.BETTER_AUTH_SECRET)}`)}`;
  const authenticated = await fetch(`${web}/api/auth/get-session`, { headers: { cookie }, redirect: "error", signal: AbortSignal.timeout(20000) });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json())?.user?.id, subject, "Production must recognize the dedicated test session");
  report("authenticated-fixture");
  assert(!interrupted, "Acceptance interrupted");
  roomAttempted = true;
  await settle({ ...envelope(), action: "create", sceneId: null, label: "Automated asset acceptance", linkRole: "none" });
  const roomKey = generateRoomKey();
  await settle({ ...envelope(), action: "set-key-check", expectedGeneration: 1, keyCheck: [...Buffer.from(await sealRoomKeyCheck({ roomKey, roomId, authGeneration: 1 }), "base64")] });
  const codec = await createAssetCryptoCodec({ roomKey, roomId, authGeneration: 1 });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const fileId = createHash("sha1").update(Buffer.from(png, "base64")).digest("hex");
  const payload = encodeCollaborationAssetPayload({ roomId, excalidrawFileId: fileId, mimeType: "image/png", dataUrl: `data:image/png;base64,${png}` }); assert(payload.ok);
  const plaintext = payload.bytes;
  const sealed = await codec.seal({ excalidrawFileId: fileId, plaintext });
  assert(sealed.ok);
  const bytes = sealed.ciphertext;
  const intent = { ...envelope(), kind: "asset-finalize", authGeneration: 1, authorityEpoch: 1, expectedRevision: 0, checksum: digest(bytes), excalidrawFileId: fileId, cryptoVersion: 1, byteLength: bytes.byteLength };
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
  const ciphertext = new Uint8Array(await downloaded.arrayBuffer()); assert.deepEqual(ciphertext, bytes);
  const opened = await codec.open({ excalidrawFileId: fileId, ciphertext }); assert(opened.ok); assert.deepEqual(opened.plaintext, plaintext);
  assert(decodeCollaborationAssetPayload(opened.plaintext, { roomId, excalidrawFileId: fileId }).ok);
  report("real-callback-download-decryption-passed");
  if (failureInjection) { injectedFailure = true; report("intentional-failure-after-real-upload"); throw new Error("acceptance failure injection"); }
  assert(!interrupted, "Acceptance interrupted");
  const snapshotKey = await deriveSnapshotKey({ roomKey, roomId, authGeneration: 1 });
  const snapshot = await sealCollaborationSnapshot({ key: snapshotKey, plaintext: new TextEncoder().encode(JSON.stringify({ elements: [{ type: "image", fileId }], appState: {} })), roomId, authGeneration: 1, revision: 1 }); assert(snapshot.ok);
  const checksum = digest(snapshot.ciphertext);
  const operation = { ...envelope(), kind: "snapshot-put", authGeneration: 1, authorityEpoch: 1, expectedRevision: 0, checksum };
  const saved = await fetch(`${gateway}/v1/snapshot`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, "content-type": "application/octet-stream", [SNAPSHOT_REQUEST_HEADER]: JSON.stringify({ proof: proof(), request: { action: "write", operation } }) }, body: snapshot.ciphertext });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).status, "written");
  await settle({ ...envelope(), action: "complete-initialization", manifest: { authGeneration: 1, revision: 1, checksum, assetIds: [fileId] } });
  testPassed = true; report("attachment-initialization-passed");
} catch (error) {
  // Do not log SQL, signed URLs, cookie, provider response, keys or encrypted payload.
  report("test-failed", { errorName: error instanceof Error ? error.name : "unknown" });
} finally {
  try {
    let ended = !roomAttempted;
    if (roomAttempted) {
      try { await retry(() => settle({ ...envelope(), action: "end-room" })); ended = true; }
      catch { report("room-end-unconfirmed-provider-cleanup-will-still-run"); }
    }
    // A lost presign response must not hide this run's uploaded objects.
    if (fixtureCreated) for (const file of await providerFiles()) if (file.name === `${runId}.bin`) keys.add(file.key);
    await saveJournal();
    for (const key of keys) {
      const deleted = await retry(() => utapi.deleteFiles(key)); assert.equal(deleted.success, true);
    }
    for (let attempt = 0; keys.size > 0; attempt++) {
      const remaining = (await providerFiles()).filter((file) => keys.has(file.key));
      if (!remaining.length) break;
      assert(attempt < 30, "Provider deletion remains pending"); await pause(2000);
    }
    assert(ended, "Room end must be confirmed before removing its owner");
    if (fixtureCreated) await sql`delete from drawstuff_user where id=${subject} and email=${email}`;
    // Expired fixture proofs plus the deleted account prevent delayed requests from recreating authority.
    while (Date.now() < lastProofExpires + 1000) await pause(Math.min(5000, lastProofExpires + 1000 - Date.now()));
    if (roomAttempted) {
      report("temporary-cleanup-runtime-deploying");
      maintenanceAttempted = true; await saveJournal();
      await command(["exec", "wrangler", "deploy", `${directory}/cleanup.ts`, "--config", "wrangler.jsonc", "--keep-vars"]);
      const result = await retry(() => jsonPost("/internal/asset-test-cleanup", {})); assert.equal(result.cleared, true);
    }
    await sql.begin(async (tx) => {
      await tx`delete from drawstuff_collaboration_projection_tombstone where room_id=${roomId}`;
      await tx`delete from drawstuff_collaboration_lifecycle_registration where room_id=${roomId}`;
      await tx`delete from drawstuff_collaboration_lifecycle_subject where scope=${`account:${subject}`} and subject=${subject}`;
      for (const key of keys) await tx`delete from drawstuff_deferred_file_cleanup where ut_file_key=${key}`;
      const [remaining] = await tx`select (select count(*) from drawstuff_user where id=${subject}) + (select count(*) from drawstuff_session where id=${sessionId}) + (select count(*) from drawstuff_collaboration_room where room_id=${roomId}) + (select count(*) from drawstuff_collaboration_asset where room_id=${roomId}) as count`;
      assert.equal(Number(remaining.count), 0);
    });
    cleanupPassed = true; report("provider-db-do-cleanup-passed");
  } catch (error) { report("cleanup-unconfirmed", { errorName: error instanceof Error ? error.name : "unknown", recoveryJournal: journal }); }
  finally {
    if (maintenanceAttempted) {
      try {
        report("normal-worker-restoring");
        await retry(() => command(["exec", "wrangler", "deploy", `${directory}/restore/index.js`, "--config", "wrangler.jsonc", "--no-bundle", "--keep-vars"]));
        const response = await fetch(`${gateway}/v1/authority`, { method: "POST", signal: AbortSignal.timeout(20000) }); assert.equal(response.status, 401);
        const cleanupRoute = await fetch(`${gateway}/internal/asset-test-cleanup`, { method: "POST", signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}` } }); assert.equal(cleanupRoute.status, 404);
        assert.deepEqual(sortedBindings(await cfGet(settingsPath)), initialBindings, "Worker bindings and variables must be restored");
        assert.equal(digest(await deployedRuntime()), normalRuntimeHash, "Deployed Worker module must exactly match the pre-test backup");
        restored = true; report("normal-worker-restored");
      } catch { report("restore-unconfirmed", { recoveryJournal: journal }); }
    } else restored = true;
    await sql.end();
    if (cleanupPassed && restored) { await rm(directory, { recursive: true, force: true }); await rm(journal, { force: true }); await rm(lock, { force: true }); }
    else await saveJournal();
  }
}
const expectedFailureHandled = failureInjection && injectedFailure && cleanupPassed && restored;
report("result", { testPassed, cleanupPassed, restored, expectedFailureHandled });
if ((!testPassed && !expectedFailureHandled) || !cleanupPassed || !restored) process.exitCode = 1;
