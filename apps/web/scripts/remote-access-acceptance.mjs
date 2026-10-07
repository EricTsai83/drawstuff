/** Scope-2 protocol-6 acceptance. No fault controller ships in the normal Worker. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { createRealtimeCryptoCodec } from "@drawstuff/collaboration/realtime-crypto";
import { encodeRelayDataFrame } from "@drawstuff/collaboration/relay-protocol";
import { sealCollaborationSnapshot } from "@drawstuff/collaboration/snapshot";
import { SNAPSHOT_REQUEST_HEADER } from "@drawstuff/collaboration/authority";

export function faultRuntimeSource({ roomId, runId, gateway }) {
  return `import { timingSafeEqual } from "node:crypto";
import { CollaborationRoom as Room } from "../../src/room.ts";
import { handleGatewayRequest } from "../../src/gateway.ts";
export { CollaborationLifecycle } from "../../src/lifecycle.ts";
const roomId=${JSON.stringify(roomId)}, prefix=${JSON.stringify(`/internal/access-test/${runId}/`)}, adapter=${JSON.stringify(`${gateway}/api/internal/collaboration/adapter`)};
export class CollaborationRoom extends Room {
  private readonly originalAdapter:string;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,{...env}); this.originalAdapter=env.COLLAB_ADAPTER_URL;
    if(ctx.id.name===roomId){
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS acceptance_fault(id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL,failures INTEGER NOT NULL); INSERT OR IGNORE INTO acceptance_fault VALUES(1,0,0)");
      if(ctx.storage.sql.exec<{enabled:number}>("SELECT enabled FROM acceptance_fault").one().enabled) this.env.COLLAB_ADAPTER_URL=adapter;
    }
  }
  override async fetch(request:Request):Promise<Response>{
    const internal="https://internal.invalid/access-test/";
    if(!request.url.startsWith(internal)) return super.fetch(request);
    return Response.json(this.accessTest(request.url.slice(internal.length)));
  }
  private accessTest(action:string){
    if(this.ctx.id.name!==roomId) throw new Error("wrong-fixture");
    if(action==="restart") this.ctx.abort("scoped acceptance restart");
    if(action==="fault-on" || action==="fault-off"){
      const enabled=action==="fault-on" ? 1 : 0;
      this.ctx.storage.sql.exec("UPDATE acceptance_fault SET enabled=? WHERE id=1",enabled);
      this.env.COLLAB_ADAPTER_URL=enabled ? adapter : this.originalAdapter;
    }else if(action==="record-failure") this.ctx.storage.sql.exec("UPDATE acceptance_fault SET failures=failures+1 WHERE id=1");
    else if(action!=="probe") throw new Error("wrong-action");
    return {constructedAt:this.constructedAt,...this.ctx.storage.sql.exec<{enabled:number;failures:number}>("SELECT enabled,failures FROM acceptance_fault").one()};
  }
}
type AccessEnv=Omit<Env,"COLLABORATION_ROOM"> & {COLLABORATION_ROOM:DurableObjectNamespace<CollaborationRoom>};
function authorized(request:Request,secret:string){
 const expected=new TextEncoder().encode(secret??""), token=new TextEncoder().encode(request.headers.get("authorization")?.replace(/^Bearer /,"")??"");
 return expected.length>=32 && expected.length===token.length && timingSafeEqual(expected,token);
}
export default {async fetch(request:Request,env:AccessEnv):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(path==="/api/internal/collaboration/adapter"){
   if(!authorized(request,env.COLLAB_ADAPTER_SECRET)) return new Response(null,{status:401});
   await env.COLLABORATION_ROOM.getByName(roomId).fetch("https://internal.invalid/access-test/record-failure");
   return Response.json({error:"scoped-adapter-unavailable"},{status:503});
 }
 if(path.startsWith(prefix)){
   if(request.method!=="POST" || !authorized(request,env.COLLAB_AUTHORITY_SECRET)) return new Response(null,{status:401});
   const action=path.slice(prefix.length);
   if(!["probe","fault-on","fault-off","restart"].includes(action)) return new Response(null,{status:404});
   try {return await env.COLLABORATION_ROOM.getByName(roomId).fetch("https://internal.invalid/access-test/"+action);}
   catch(error) {return Response.json({errorName:error instanceof Error ? error.name : "unknown"},{status:503});}
 }
 return handleGatewayRequest(request,env);
}} satisfies ExportedHandler<AccessEnv>;
`;
}

export async function runAccessAcceptance(c) {
  const { roomId, runId, gateway, web, guest, peer, peerCookie, roomKey, snapshotKey, fileId, bytes, sql, keys, saveJournal, proof, envelope, jsonPost, settle, connect, until, report } = c;
  let refusedProbeReported = false;
  const control = async (action) => {
    const response = await fetch(`${gateway}/internal/access-test/${runId}/${action}`, { method: "POST", headers: { authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`, connection: "close" }, signal: AbortSignal.timeout(20000) });
    if(action === "restart") { assert.equal(response.status,503); await response.body?.cancel(); return; }
    if (response.status !== 200 && !refusedProbeReported) { refusedProbeReported=true; report("fault-controller-refused",{action,http:response.status}); }
    assert.equal(response.status,200); return response.json();
  };
  report("scoped-fault-runtime-deploying"); await c.deployFault();
  await until(async () => { try { return (await control("probe")).enabled === 0; } catch { await pause(15000); return false; } },180000);
  report("scoped-fault-runtime-ready");
  const codec = await createRealtimeCryptoCodec({ roomKey, roomId, authGeneration:1 });
  const received = new WeakMap();
  const watch = (socket) => { const messages=[]; received.set(socket.ws,messages); socket.ws.on("message",(data,binary)=>{if(binary)messages.push(new Uint8Array(data));}); return socket; };
  const fanout = async (sender,targets,excluded=[]) => {
    const sealed=await codec.seal(new TextEncoder().encode(crypto.randomUUID()),"scene"); assert(sealed.ok);
    const frame=encodeRelayDataFrame("scene",sealed.frame);
    const counts=targets.map(s=>received.get(s.ws).length), absent=excluded.map(s=>received.get(s.ws).length);
    sender.ws.send(frame);
    await until(()=>Promise.resolve(targets.every((s,i)=>received.get(s.ws).length>counts[i])));
    for(const [i,s] of targets.entries()) assert.deepEqual(received.get(s.ws)[counts[i]],frame);
    await pause(200);
    for(const [i,s] of excluded.entries()) assert.equal(received.get(s.ws).length,absent[i]);
  };
  const close = async (...members) => { for(const member of members) member.ws.terminate(); await until(()=>Promise.resolve(members.every(s=>s.ws.readyState===3))); };
  let a=watch(await connect());
  await settle({...envelope(),action:"set-link-role",linkRole:"viewer"});
  let d=watch(await connect(peer)); assert.equal(d.joined.role,"viewer");
  await settle({...envelope(),action:"set-link-role",linkRole:"none"});
  await assert.rejects(()=>connect(guest));
  await settle({...envelope(),action:"allow-email",email:guest.email,role:"editor"});
  let b=watch(await connect(guest)); assert.equal(b.joined.role,"editor");
  const viewerSealed=await codec.seal(new Uint8Array([1,2,3]),"scene");assert(viewerSealed.ok);
  const viewerFrame=encodeRelayDataFrame("scene",viewerSealed.frame);
  const beforeA=received.get(a.ws).length, beforeB=received.get(b.ws).length;
  d.ws.send(viewerFrame); await until(()=>Promise.resolve(d.ws.readyState===3)); await pause(200);
  assert.equal(received.get(a.ws).length,beforeA); assert.equal(received.get(b.ws).length,beforeB);
  report("viewer-scene-write-rejected");
  await settle({...envelope(),action:"set-member-role",subject:peer.subject,role:"editor"});
  d=watch(await connect(peer)); assert.equal(d.joined.role,"editor");
  report("three-party-sockets-joined");
  await fanout(a,[b,d]); await fanout(d,[a,b]);
  report("three-party-encrypted-fanout-passed");
  await settle({...envelope(),action:"remove-email",email:guest.email});
  await until(()=>Promise.resolve(b.ws.readyState===3));await assert.rejects(()=>connect(guest));
  await settle({...envelope(),action:"set-member-role",subject:guest.subject,role:"editor"});
  b=watch(await connect(guest));assert.equal(b.joined.role,"editor");
  report("three-party-roles-and-allowlist-passed");

  const state=(await jsonPost("/v1/authority",{proof:proof(),request:{...envelope(),action:"get-state"}})).result;
  let snapshot=await sealCollaborationSnapshot({key:snapshotKey,plaintext:new TextEncoder().encode('{"elements":[],"appState":{}}'),roomId,authGeneration:1,revision:2});assert(snapshot.ok);
  let operation={...envelope(),kind:"snapshot-put",authGeneration:1,authorityEpoch:state.authorityEpoch,expectedRevision:1,checksum:createHash("sha256").update(snapshot.ciphertext).digest("hex")};
  const write=async()=>{
    const response=await fetch(`${gateway}/v1/snapshot`,{method:"POST",headers:{authorization:`Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`,"content-type":"application/octet-stream",[SNAPSHOT_REQUEST_HEADER]:JSON.stringify({proof:proof(),request:{action:"write",operation}})},body:snapshot.ciphertext,redirect:"error",signal:AbortSignal.timeout(20000)});
    if(response.status===200)return response.json();await response.body?.cancel();return {status:"http-error"};
  };
  const ready=Promise.withResolvers(), release=Promise.withResolvers();
  const held=sql.begin(async tx=>{await tx`select room_id from drawstuff_collaboration_room where room_id=${roomId} for update`;const [row]=await tx`select pg_backend_pid() as pid`;ready.resolve(row.pid);await release.promise;});
  void held.catch(ready.reject);let blockedWrite;
  try {
    const pid=await ready.promise;blockedWrite=write().catch(()=>({status:"http-error"}));
    await until(async()=>{const [row]=await sql`select exists(select 1 from pg_stat_activity a where ${pid}=any(pg_blocking_pids(a.pid))) as blocked`;return row.blocked;},10000);
    await fanout(a,[b,d]);await fanout(b,[a,d]);
  } finally {release.resolve();await held;}
  const blockedResult=await blockedWrite;
  assert(["written","pending"].includes(blockedResult.status));
  await until(async()=> (await write()).status==="written",60000);
  report("real-postgres-blocked-save-and-live-fanout-passed");
  snapshot=await sealCollaborationSnapshot({key:snapshotKey,plaintext:new TextEncoder().encode('{"elements":[],"appState":{}}'),roomId,authGeneration:1,revision:3});assert(snapshot.ok);
  operation={...envelope(),kind:"snapshot-put",authGeneration:1,authorityEpoch:state.authorityEpoch,expectedRevision:2,checksum:createHash("sha256").update(snapshot.ciphertext).digest("hex")};
  const intent={...envelope(),kind:"asset-finalize",authGeneration:1,authorityEpoch:state.authorityEpoch,expectedRevision:0,checksum:createHash("sha256").update(bytes).digest("hex"),excalidrawFileId:fileId,cryptoVersion:1,byteLength:bytes.byteLength};
  const presign=await fetch(`${web}/api/uploadthing?slug=collaborationAssetUploader&actionType=upload`,{method:"POST",headers:{cookie:peerCookie,"content-type":"application/json","x-uploadthing-version":"7.7.4"},body:JSON.stringify({input:intent,files:[{name:`${runId}.bin`,type:"application/octet-stream",size:bytes.byteLength,lastModified:Date.now()}]}),redirect:"error",signal:AbortSignal.timeout(20000)});
  assert.equal(presign.status,200); const [signed]=await presign.json(); assert.equal(typeof signed.key,"string"); keys.add(signed.key); await saveJournal();
  await control("fault-on");
  report("scoped-adapter-failure-enabled");
  const failed=await write(); assert.notEqual(failed.status,"written");
  const revoke={...envelope(),action:"revoke-member",subject:peer.subject};
  const denied=(await jsonPost("/v1/authority",{proof:proof(),request:revoke})).result; assert.equal(denied.status,"pending");
  await until(()=>Promise.resolve(d.ws.readyState===3));
  await fanout(a,[b],[d]); await fanout(b,[a],[d]);
  await assert.rejects(()=>connect(peer));
  const assetRequest=async request=>{
    const response=await fetch(`${gateway}/v1/assets`,{method:"POST",headers:{authorization:`Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`,"content-type":"application/json"},body:JSON.stringify({proof:proof(peer),request}),redirect:"error",signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,403);assert.equal((await response.json()).error,"forbidden");return {status:"refused"};
  };
  assert.equal((await assetRequest({...envelope(),action:"read",fileIds:[fileId]})).status,"refused");
  assert.equal((await assetRequest({action:"prepare",intent})).status,"refused");
  assert.equal((await assetRequest({action:"finalize",intent,asset:{excalidrawFileId:fileId,cryptoVersion:1,byteLength:bytes.byteLength,url:"https://untrusted.invalid/refused",utFileKey:signed.key}})).status,"refused");
  assert(Date.now()<intent.deadline,"Late callback must use an unexpired presign");
  const form=new FormData();form.append("file",new File([bytes],`${runId}.bin`,{type:"application/octet-stream"}));
  const upload=await fetch(signed.url,{method:"PUT",headers:{Range:"bytes=0-","x-uploadthing-version":"7.7.4"},body:form,redirect:"error",signal:AbortSignal.timeout(120000)});
  assert.equal(upload.status,200);assert.equal((await upload.json()).serverData?.status,"unknown");
  const [orphan]=await sql`select ut_file_key from drawstuff_deferred_file_cleanup where ut_file_key=${signed.key}`;assert(orphan);
  const probe=await control("probe"); assert(probe.failures>0);
  report("external-failure-local-revocation-and-fanout-passed");
  await control("restart");
  await until(async()=>{const p=await control("probe");return p.constructedAt!==probe.constructedAt&&p.enabled===1;});
  await assert.rejects(()=>connect(peer));
  await control("fault-off");
  await until(async()=>((await jsonPost("/v1/authority",{proof:proof(),request:{...envelope(),action:"query",operationId:revoke.operationId}})).result.status==="enforced"),90000);
  await close(a,b); a=watch(await connect());b=watch(await connect(guest));assert.equal(b.joined.role,"editor");await fanout(a,[b]);await fanout(b,[a]);await assert.rejects(()=>connect(peer));
  // An uncommitted pre-revocation operation must stay fenced; a fresh owner save uses the new epoch.
  const oldResult=await write();assert.notEqual(oldResult.status,"written");
  const current=(await jsonPost("/v1/authority",{proof:proof(),request:{...envelope(),action:"get-state"}})).result;
  operation={...operation,...envelope(),authorityEpoch:current.authorityEpoch};
  const recovered=await write();assert.equal(recovered.status,"written");assert.equal(recovered.revision,3);
  assert.deepEqual(await write(),recovered);
  report("scoped-adapter-failure-restart-and-revocation-passed",{realSockets:3,failedAdapterRequests:probe.failures,lateCallbackRejected:true,saveRecovered:true});
}
