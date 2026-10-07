/** Protocol-6 product path. Requires real verified principals when used remotely. */
import assert from "node:assert/strict";
import {setTimeout as pause} from "node:timers/promises";
import {WebSocket} from "ws";
import {signIdentityProof} from "@drawstuff/collaboration/room-token";
import {sealRoomKeyCheck,KEYCHECK_CIPHERTEXT_BYTES} from "@drawstuff/collaboration/keycheck";
import {generateRoomKey} from "@drawstuff/collaboration/realtime-crypto";
import {deriveSnapshotKey,sealCollaborationSnapshot,openCollaborationSnapshot,MAX_SNAPSHOT_PLAINTEXT_BYTES} from "@drawstuff/collaboration/snapshot";
import {SNAPSHOT_REQUEST_HEADER,SNAPSHOT_RECEIPT_HEADER} from "@drawstuff/collaboration/authority";

export async function runProductHarness({base,owner,guest,identitySecret,serviceSecret,origin="http://localhost:3000",advance,retire=false,samples=1}) {
  const roomId=`harness-${crypto.randomUUID()}`,roomKey=generateRoomKey();
  const key=await deriveSnapshotKey({roomKey,roomId,authGeneration:1});
  const plaintext=new Uint8Array(MAX_SNAPSHOT_PLAINTEXT_BYTES).fill(37);
  const sealed=await sealCollaborationSnapshot({key,plaintext,roomId,authGeneration:1,revision:1});assert.equal(sealed.ok,true);
  const bytes=sealed.ciphertext,checksum=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
  const envelope=()=>({v:1,roomId,operationId:crypto.randomUUID(),deadline:Date.now()+60_000});
  const proof=(identity=owner)=>{const now=Math.floor(Date.now()/1000);return signIdentityProof({v:1,aud:"drawstuff-room-identity",protocolVersion:6,jti:crypto.randomUUID(),iat:now,exp:now+60,roomId,identity},identitySecret);};
  const post=async(path,body)=>{const response=await fetch(`${base}${path}`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(20_000),headers:{"content-type":"application/json",authorization:`Bearer ${serviceSecret}`},body:JSON.stringify(body)});assert.equal(response.status,200,`${path} status=${response.status}`);return response.json();};
  const settle=async(request)=>{
    let result=(await post("/v1/authority",{proof:proof(),request})).result;
    for(let attempt=0;result.status==="pending"&&attempt<45;attempt++){
      await advance?.({roomId});await pause(1000);
      result=(await post("/v1/authority",{proof:proof(),request:{...envelope(),action:"query",operationId:request.operationId}})).result;
    }
    assert.equal(result.status,"enforced");
  };
  let socket;
  try{
    await settle({...envelope(),action:"create",sceneId:null,label:"Harness",linkRole:"editor"});
    const check=Buffer.from(await sealRoomKeyCheck({roomKey,roomId,authGeneration:1}),"base64");
    assert.equal(check.byteLength,KEYCHECK_CIPHERTEXT_BYTES);
    await settle({...envelope(),action:"set-key-check",expectedGeneration:1,keyCheck:[...check]});
    const operation={...envelope(),kind:"snapshot-put",authGeneration:1,authorityEpoch:1,expectedRevision:0,checksum};
    const snapshot=await fetch(`${base}/v1/snapshot`,{method:"POST",signal:AbortSignal.timeout(20_000),headers:{authorization:`Bearer ${serviceSecret}`,"content-type":"application/octet-stream",[SNAPSHOT_REQUEST_HEADER]:JSON.stringify({proof:proof(),request:{action:"write",operation}})},body:bytes});assert.equal(snapshot.status,200);assert.equal((await snapshot.json()).status,"written");
    const timings=[];
    for(let sample=0;sample<samples;sample++){
      const started=performance.now();
      const response=await fetch(`${base}/v1/snapshot`,{method:"POST",signal:AbortSignal.timeout(20_000),headers:{authorization:`Bearer ${serviceSecret}`,"content-type":"application/octet-stream",[SNAPSHOT_REQUEST_HEADER]:JSON.stringify({proof:proof(),request:{...envelope(),action:"read"}})}});
      assert.equal(response.status,200);assert.ok(response.headers.get(SNAPSHOT_RECEIPT_HEADER));
      const ciphertext=new Uint8Array(await response.arrayBuffer());
      const opened=await openCollaborationSnapshot({key,ciphertext,roomId,authGeneration:1,revision:1});assert.equal(opened.ok,true);assert.deepEqual(opened.plaintext,plaintext);
      timings.push(performance.now()-started);
    }
    const intent={...envelope(),kind:"asset-finalize",authGeneration:1,authorityEpoch:1,expectedRevision:0,checksum,excalidrawFileId:"fixture-image",cryptoVersion:1,byteLength:128};
    // Provider callback tests cover UploadThing signatures. This fixture exercises only private descriptor binding.
    if(advance){
      assert.equal((await post("/v1/assets",{proof:proof(),request:{action:"prepare",intent}})).result.status,"authorized");
      assert.equal((await post("/v1/assets",{proof:proof(),request:{action:"finalize",intent,asset:{excalidrawFileId:intent.excalidrawFileId,cryptoVersion:1,byteLength:128,url:"https://provider.test/sealed-image",utFileKey:"sealed-key"}}})).result.status,"written");
    }
    await settle({...envelope(),action:"complete-initialization",manifest:{authGeneration:1,revision:1,checksum,assetIds:advance?[intent.excalidrawFileId]:[]}});
    socket=new WebSocket(`${base.replace(/^http/,"ws")}/v1/rooms/${roomId}/socket`,{headers:{Origin:origin}});
    const event=(name)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`${name}-timeout`)),10_000);socket.once(name,value=>{clearTimeout(timer);resolve(value);});socket.once("error",error=>{clearTimeout(timer);reject(error);});if(name!=="close")socket.once("close",code=>{clearTimeout(timer);reject(new Error(`closed-${code}`));});});
    await event("open");const joined=event("message");socket.send(JSON.stringify({control:"join",protocolVersion:6,roomId,token:proof(guest)}));assert.equal(JSON.parse((await joined).toString()).role,"editor");
    const closed=event("close");await settle({...envelope(),action:"revoke-member",subject:guest.subject});await closed;
    assert.equal((await fetch(`${base}/v1/rooms/${roomId}/generations/1/socket`,{signal:AbortSignal.timeout(10_000)})).status,404);
    if(retire){
      const command={v:1,operationId:crypto.randomUUID(),actor:owner.subject,target:{kind:"account",subject:owner.subject}};
      let result=await post("/v1/lifecycle",{action:"begin",command});
      for(let step=0;result.phase!=="completed"&&step<45;step++){await pause(1100);await advance?.({lifecycle:`account:${owner.subject}`});result=await post("/v1/lifecycle",{action:"query",target:command.target,operationId:command.operationId});}
      assert.equal(result.phase,"completed");
    }else await settle({...envelope(),action:"end-room"});
    const sorted=timings.toSorted((a,b)=>a-b),percentile=p=>Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]);
    console.log(`protocol-6 product harness OK: max encrypted snapshot round-trip; ready; WebSocket; revoke; ${retire?"Lifecycle retirement":"end"}; read samples=${samples} p95=${percentile(.95)}ms p99=${percentile(.99)}ms`);
  }finally{socket?.terminate();}
}
export async function runRemoteProductHarness(samples=1){
  const base=process.argv[2];if(!base||new URL(base).protocol!=="https:")throw new Error("usage: <command> <https-gateway-origin>");
  const required=name=>{const value=process.env[name];if(!value)throw new Error(`Missing ${name}`);return value;};
  const principal=prefix=>({subject:required(`${prefix}_SUBJECT`),email:required(`${prefix}_EMAIL`),lifecycleVersion:Number(required(`${prefix}_VERSION`))});
  await runProductHarness({base:new URL(base).origin,owner:principal("COLLAB_HARNESS_OWNER"),guest:principal("COLLAB_HARNESS_GUEST"),identitySecret:required("COLLAB_IDENTITY_SECRET"),serviceSecret:required("COLLAB_AUTHORITY_SECRET"),origin:required("COLLAB_SMOKE_ORIGIN"),samples});
}
