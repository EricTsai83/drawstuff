/** Protocol-6 production timings. No browser, fabricated provider, or fake clock. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import {
  createAssetCryptoCodec, encodeCollaborationAssetPayload, decodeCollaborationAssetPayload,
} from "@drawstuff/collaboration/asset";
import {
  encodeCollaborationSnapshot, decodeCollaborationSnapshot,
  sealCollaborationSnapshot, openCollaborationSnapshot,
} from "@drawstuff/collaboration/snapshot";
import { SNAPSHOT_REQUEST_HEADER, SNAPSHOT_RECEIPT_HEADER, contentResultSchema } from "@drawstuff/collaboration/authority";
import { createRealtimeCryptoCodec } from "@drawstuff/collaboration/realtime-crypto";
import { encodeRelayDataFrame } from "@drawstuff/collaboration/relay-protocol";
import { z } from "zod";
import { Agent, buildConnector } from "undici";
import undiciPackage from "undici/package.json" with {type:"json"};
import { PERFORMANCE_PROBE_HEADER, readServerTimings, performanceTimingsSchema } from "@drawstuff/collaboration/performance";
import { issuePerformanceProbe } from "../src/server/collab/performance-probe.ts";

const WARMUP = 20, SAMPLES = 200, TYPICAL_BYTES = 256 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const cacheStatuses = new Set(["HIT","MISS","DYNAMIC","BYPASS","EXPIRED","STALE","UPDATING","REVALIDATED"]);
const cacheStatus = response => {
  const value=response.headers.get("cf-cache-status");
  return cacheStatuses.has(value) ? value : "unreported";
};
const summary = values => {
  const sorted = values.toSorted((a,b) => a-b);
  const at = p => sorted.length ? Math.round(sorted[Math.ceil(sorted.length*p)-1]*100)/100 : null;
  return { samples: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};

// Insert a valid PNG tEXt chunk before IEND; no trailing garbage or fake asset URL.
function pngFixture() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
  const text = Buffer.from(("fixture\0" + randomUUID()).padEnd(48*1024,"x"));
  const chunk = Buffer.alloc(text.length+12);chunk.writeUInt32BE(text.length);
  chunk.write("tEXt",4);text.copy(chunk,8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4,-4)) {
    crc ^= byte;for(let bit=0;bit<8;bit++) crc = (crc>>>1) ^ ((crc&1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
}
function canvas(roomId,fileId,version) {
  const text = {id:"text",version,versionNonce:version,isDeleted:false,type:"text",text:""};
  const elements = [{id:"image",version,versionNonce:version,isDeleted:false,type:"image",fileId,x:0,y:0,width:10,height:10},text];
  const base=encodeCollaborationSnapshot({roomId,elements});assert(base.ok);
  text.text="x".repeat(TYPICAL_BYTES-base.bytes.length);
  const encoded=encodeCollaborationSnapshot({roomId,elements});assert(encoded.ok);assert.equal(encoded.bytes.length,TYPICAL_BYTES);return encoded.bytes;
}

export async function runTypicalHotPerformance(c) {
  const {roomId,runId,web,gateway,cookie,roomKey,snapshotKey,guest,keys,saveJournal,proof,envelope,connect,until,report} = c;
  // A scoped dispatcher changes only measured HTTP requests, never provider cleanup or SDK calls.
  const transport = {requested:c.http2 ? "h2-with-h1-fallback" : "node-default",connections:{},requests:{}};
  const category = hostname => hostname === new URL(web).hostname ? "web" : hostname === new URL(gateway).hostname ? "gateway" : "provider";
  const connector = buildConnector({allowH2:true});
  const dispatcher = c.http2 ? new Agent({allowH2:true,connect(options,callback) {
    connector(options,(error,socket)=>{
      if(!error) {
        const label=category(options.hostname);
        const protocol=socket.alpnProtocol === "h2" ? "h2" : socket.alpnProtocol === "http/1.1" ? "http/1.1" : "unreported";
        const key=`${label}:${protocol}`;
        transport.connections[key]=(transport.connections[key]??0)+1;
      }
      callback(error,socket);
    });
  }}) : undefined;
  const measuredFetch = (url,options) => {
    if(dispatcher) {
      const label=category(new URL(url).hostname);
      transport.requests[label]=(transport.requests[label]??0)+1;
    }
    return fetch(url,{...options,...(dispatcher ? {dispatcher} : {})});
  };
  const jsonPost=(path,body,timings)=>c.jsonPost(path,body,timings,measuredFetch);
  const samples = c.diagnostic ? 20 : SAMPLES;
  const result={schemaVersion:1,scope:"3A",startedAt:new Date().toISOString(),warmup:WARMUP,requiredSamples:SAMPLES,
    purpose:c.http2 ? "http2-acceptance" : c.snapshotDiagnostic ? "snapshot-latency-diagnostic" : c.presignDiagnostic ? "presign-lifecycle-diagnostic" : c.serverDiagnostic ? "server-latency-diagnostic" : c.providerDiagnostic ? "provider-latency-diagnostic" : c.diagnostic ? "latency-diagnostic" : "acceptance",plannedSamples:samples,
    scenario:"typical-hot-real-upload",snapshotPlaintextBytes:TYPICAL_BYTES,assetPlaintextBytes:null,
    runtime:{client:process.version,bundledUndici:process.versions.undici,dispatcherUndici:c.http2 ? undiciPackage.version : null,httpTransport:transport,protocol:6,fixtureConcurrency:1,initializationIngress:"production Vercel tRPC",uncommittedMeasurementTools:Boolean(c.toolsUncommitted)},
    measurementBoundary:"verified principals -> Gateway -> DO -> production adapter/Neon and genuine UploadThing callback; join includes baseline, asset download/decode and socket fanout",
    limitations:[c.serverDiagnostic ? "OAuth, web proof issuance and UI application are excluded; asset presign session and rate-limit spans are measured" : "OAuth, web proof issuance/rate-limit ingress and UI application are excluded", "hot DO maintained by live presence traffic; Vercel/Neon cold starts are not independently classified", c.snapshotDiagnostic ? "asset and snapshot service/DB spans are measured; snapshot response delivery, callback dispatch, RPC handler-external waiting and provider/network attribution remain unclassified" : c.serverDiagnostic ? "asset path records service and DB transaction spans; snapshot spans, callback dispatch and provider/network attribution remain unclassified" : "client segments are measured; DO->Vercel and adapter->Neon spans require subsequent instrumentation"],
    thresholdsMs:{save:{p95:3000,p99:8000},join:{p95:3000,p99:5000}},
    records:[],warmupRecords:[],failures:0,gatePassed:false,completed:false};
  c.observe(result);
  const assetCodec=await createAssetCryptoCodec({roomKey,roomId,authGeneration:1});
  const realtime=await createRealtimeCryptoCodec({roomKey,roomId,authGeneration:1});
  const owner=await connect();let revision=1, heartbeatError=false, heartbeatRunning=false;
  const heartbeat=setInterval(()=>{
    if(heartbeatRunning || owner.ws.readyState!==1) return;
    heartbeatRunning=true;
    void realtime.seal(new TextEncoder().encode("{}"),"presence").then(sealed=>{
      assert(sealed.ok);owner.ws.send(encodeRelayDataFrame("presence",sealed.frame));
    }).catch(()=>{heartbeatError=true;}).finally(()=>{heartbeatRunning=false;});
  },5000);
  const snapshotRequest=async(request,body,identity,timings)=>{
    const response=await measuredFetch(`${gateway}/v1/snapshot`,{
    method:"POST",headers:{authorization:`Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`,"content-type":"application/octet-stream",
      [SNAPSHOT_REQUEST_HEADER]:JSON.stringify({proof:proof(identity),request}),...(timings ? {[PERFORMANCE_PROBE_HEADER]:"1"} : {})},
    ...(body ? {body} : {}),redirect:"error",signal:AbortSignal.timeout(20000),
    });
    if(timings) Object.assign(timings,readServerTimings(response.headers.get("server-timing")));
    return response;
  };
  let failureContext;
  try {
    for(let index=0;index<WARMUP+samples;index++) {
      failureContext={warmup:index<WARMUP,sample:index<WARMUP ? index+1 : index-WARMUP+1,stage:"prepare"};
      assert(!c.interrupted(),"Performance acceptance interrupted");assert(!heartbeatError);assert.equal(owner.ws.readyState,1);
      const png=pngFixture(), fileId=createHash("sha1").update(png).digest("hex");
      const payload=encodeCollaborationAssetPayload({roomId,excalidrawFileId:fileId,mimeType:"image/png",dataUrl:`data:image/png;base64,${png.toString("base64")}`});assert(payload.ok);
      result.assetPlaintextBytes ??= payload.bytes.length;
      const plaintext=canvas(roomId,fileId,revision+1);
      const started=performance.now();
      const asset=await assetCodec.seal({excalidrawFileId:fileId,plaintext:payload.bytes});assert(asset.ok);
      const sealed=await sealCollaborationSnapshot({key:snapshotKey,plaintext,roomId,authGeneration:1,revision:revision+1});assert(sealed.ok);
      const cryptoMs=performance.now()-started;
      const intent={...envelope(),kind:"asset-finalize",authGeneration:1,authorityEpoch:1,expectedRevision:0,checksum:sha256(asset.ciphertext),excalidrawFileId:fileId,cryptoVersion:1,byteLength:asset.ciphertext.byteLength};
      const uploadStart=performance.now();
      failureContext.stage="presign";
      const presign=await measuredFetch(`${web}/api/uploadthing?slug=collaborationAssetUploader&actionType=upload`,{
        method:"POST",headers:{cookie,"content-type":"application/json","x-uploadthing-version":"7.7.4",...(c.serverDiagnostic ? {[PERFORMANCE_PROBE_HEADER]:issuePerformanceProbe(process.env.COLLAB_AUTHORITY_SECRET)} : {})},
        body:JSON.stringify({input:intent,files:[{name:`${runId}.bin`,type:"application/octet-stream",size:asset.ciphertext.byteLength,lastModified:Date.now()}]}),redirect:"error",signal:AbortSignal.timeout(20000),
      });assert.equal(presign.status,200);
      const presignHeadersMs=performance.now()-uploadStart;
      const presignBodyStart=performance.now();
      const [signed]=await presign.json();assert.equal(typeof signed.key,"string");
      const presignBodyMs=performance.now()-presignBodyStart;
      const routeTimings=c.serverDiagnostic ? readServerTimings(presign.headers.get("server-timing")) : {};
      const presignMs=performance.now()-uploadStart;
      keys.add(signed.key);const journalStart=performance.now();await saveJournal();
      const journalMs=performance.now()-journalStart;
      const form=new FormData();form.append("file",new File([asset.ciphertext],`${runId}.bin`,{type:"application/octet-stream"}));
      const providerStart=performance.now();
      failureContext.stage="provider-put";
      const uploaded=await measuredFetch(signed.url,{method:"PUT",body:form,headers:{Range:"bytes=0-","x-uploadthing-version":"7.7.4"},redirect:"error",signal:AbortSignal.timeout(120000)});
      const providerHeadersMs=performance.now()-providerStart;
      const providerReceiptStart=performance.now();
      assert.equal(uploaded.status,200);
      const serverData=(await uploaded.json()).serverData;
      const measured=c.serverDiagnostic ? z.strictObject({result:contentResultSchema,presign:performanceTimingsSchema,timings:performanceTimingsSchema}).parse(serverData) : undefined;
      const callback=contentResultSchema.parse(measured ? measured.result : serverData);assert(["written","pending"].includes(callback.status));
      const providerReceiptBodyMs=performance.now()-providerReceiptStart;
      const providerPutCallbackMs=performance.now()-providerStart;
      let initialPending=callback.status==="pending";
      const pendingStart=performance.now();
      if(initialPending) await until(async()=>
        (await jsonPost("/v1/assets",{proof:proof(),request:{action:"query",intent}})).result.status==="written",
      60000);
      const assetPendingMs=performance.now()-pendingStart;
      const uploadMs=performance.now()-uploadStart;
      const operation={...envelope(),kind:"snapshot-put",authGeneration:1,authorityEpoch:1,expectedRevision:revision,checksum:sha256(sealed.ciphertext)};
      failureContext.stage="snapshot-write";
      const saveStart=performance.now();let written;
      const snapshotWriteTimings=c.snapshotDiagnostic ? {} : undefined;
      let snapshotAttempts=0;
      await until(async()=>{
        snapshotAttempts++;
        const response=await snapshotRequest({action:"write",operation},sealed.ciphertext,undefined,snapshotWriteTimings);assert.equal(response.status,200);
        written=await response.json();if(written.status==="pending")initialPending=true;return written.status==="written";
      },60000);
      assert.equal(written.revision,++revision);
      const snapshotMs=performance.now()-saveStart;
      const saveMs=performance.now()-started;
      failureContext.stage="join";
      const joinStart=performance.now();let member;
      try {
        member=await connect(guest);assert.equal(member.joined.role,"editor");
        const joinSocketMs=performance.now()-joinStart;
        const baselineStart=performance.now();
        const snapshotReadTimings=c.snapshotDiagnostic ? {} : undefined;
        failureContext.stage="snapshot-read";
        const response=await snapshotRequest({...envelope(),action:"read"},undefined,guest,snapshotReadTimings);assert.equal(response.status,200);
        const receipt=JSON.parse(response.headers.get(SNAPSHOT_RECEIPT_HEADER));assert.equal(receipt.revision,revision);
        const ciphertext=new Uint8Array(await response.arrayBuffer());assert.equal(sha256(ciphertext),receipt.checksum);
        const opened=await openCollaborationSnapshot({key:snapshotKey,ciphertext,roomId,authGeneration:1,revision});assert(opened.ok);
        assert.deepEqual(opened.plaintext,plaintext);assert(decodeCollaborationSnapshot(opened.plaintext,{roomId}).ok);
        const joinSnapshotMs=performance.now()-baselineStart;
        const assetsStart=performance.now();
        const indexTimings=c.serverDiagnostic ? {} : undefined;
        failureContext.stage="asset-index";
        const lookup=(await jsonPost("/v1/assets",{proof:proof(guest),request:{...envelope(),action:"read",fileIds:[fileId]}},indexTimings)).result;
        assert.equal(lookup.assets.length,1);assert.equal(lookup.assets[0].excalidrawFileId,fileId);
        const assetIndexMs=performance.now()-assetsStart;
        const downloadStart=performance.now();
        failureContext.stage="asset-download";
        const download=await measuredFetch(lookup.assets[0].url,{redirect:"error",signal:AbortSignal.timeout(20000)});assert.equal(download.status,200);
        const assetDownloadHeadersMs=performance.now()-downloadStart;
        const assetBodyStart=performance.now();
        const assetBytes=new Uint8Array(await download.arrayBuffer());
        const assetDownloadBodyMs=performance.now()-assetBodyStart;
        assert.deepEqual(assetBytes,asset.ciphertext);
        const assetDownloadMs=performance.now()-downloadStart;
        const decodeStart=performance.now();
        const decoded=await assetCodec.open({excalidrawFileId:fileId,ciphertext:assetBytes});assert(decoded.ok);assert.deepEqual(decoded.plaintext,payload.bytes);
        assert(decodeCollaborationAssetPayload(decoded.plaintext,{roomId,excalidrawFileId:fileId}).ok);
        const assetDecodeMs=performance.now()-decodeStart;
        const joinAssetsMs=performance.now()-assetsStart;
        const clearFrame=new TextEncoder().encode(randomUUID());
        const frame=await realtime.seal(clearFrame,"scene");assert(frame.ok);
        const wire=encodeRelayDataFrame("scene",frame.frame), fanoutStart=performance.now();
        failureContext={...failureContext,stage:"fanout",segments:{saveMs,presignMs,providerPutCallbackMs,snapshotMs,joinSocketMs,joinSnapshotMs,assetIndexMs,assetDownloadMs}};
        assert.equal(owner.ws.readyState,1);assert.equal(member.ws.readyState,1);
        await new Promise((resolve,reject)=>{
          const finish=error=>{
            clearTimeout(timer);member.ws.off("message",receive);
            for(const socket of [owner.ws,member.ws]) {socket.off("close",failed);socket.off("error",failed);}
            error ? reject(error) : resolve();
          };
          const failed=()=>finish(new Error("fanout-socket-failed"));
          const timer=setTimeout(()=>finish(new Error("fanout-timeout")),10000);
          const receive=(data,binary)=>{if(binary && Buffer.from(data).equals(Buffer.from(wire)))finish();};
          for(const socket of [owner.ws,member.ws]) {socket.once("close",failed);socket.once("error",failed);}
          member.ws.on("message",receive);owner.ws.send(wire,error=>{if(error)failed();});
        });
        const received=await realtime.open(frame.frame,"scene");assert(received.ok);assert.deepEqual(received.plaintext,clearFrame);
        const fanoutMs=performance.now()-fanoutStart, joinMs=performance.now()-joinStart;
        let repeated = {};
        if(c.providerDiagnostic) {
          // Auxiliary probe begins after the first full join/fanout timer stopped.
          // No cache headers, URL rewrites or prewarming before the measured read.
          const repeatStart=performance.now();
          const response=await measuredFetch(lookup.assets[0].url,{redirect:"error",signal:AbortSignal.timeout(20000)});
          assert.equal(response.status,200);
          const repeatedDownloadHeadersMs=performance.now()-repeatStart;
          const bodyStart=performance.now();
          const bytes=new Uint8Array(await response.arrayBuffer());
          const repeatedDownloadBodyMs=performance.now()-bodyStart;
          assert.deepEqual(bytes,asset.ciphertext);
          repeated={repeatedDownloadMs:performance.now()-repeatStart,repeatedDownloadHeadersMs,repeatedDownloadBodyMs,
            firstCacheStatus:cacheStatus(download),repeatedCacheStatus:cacheStatus(response)};
        }
        failureContext.stage="server-timings";
        const server={};
        if(c.serverDiagnostic) {
          const snapshots=c.snapshotDiagnostic ? [
            ["snapshotWrite",snapshotWriteTimings,["gatewayService","room","register","registerStorage","acceptContent","receiveBody","write","writeStorage","adapterReceiveBody","settleContent"]],
            ["snapshotRead",snapshotReadTimings,["gatewayService","room","register","registerStorage","readSnapshot","readSnapshotStorage"]],
          ] : [];
          for(const [prefix,timings,required] of [
            ["presignRoute",routeTimings,["routeSession","rateLimit","uploadHandler"]],
            ["presign",measured.presign,["session","identity","gateway","gatewayService","room","register","registerStorage"]],
            ["callback",measured.timings,["callback","identity","gateway","gatewayService","room","register","registerStorage","write","writeStorage"]],
            ["index",indexTimings,["gatewayService","room","register","registerStorage","readAssets","readAssetsStorage"]],
            ...snapshots,
          ]) {
            for(const metric of required) assert.equal(typeof timings[metric],"number",`Missing ${prefix} ${metric} timing`);
            for(const [metric,value] of Object.entries(timings)) server[`${prefix}_${metric}Ms`]=value;
          }
        }
        const row={saveMs,joinMs,cryptoMs,uploadMs,presignMs,presignHeadersMs,presignBodyMs,journalMs,providerPutCallbackMs,providerHeadersMs,providerReceiptBodyMs,assetPendingMs,snapshotMs,joinSocketMs,joinSnapshotMs,joinAssetsMs,assetIndexMs,assetDownloadMs,assetDownloadHeadersMs,assetDownloadBodyMs,assetDecodeMs,fanoutMs,initialPending,...(c.snapshotDiagnostic ? {snapshotAttempts} : {}),...repeated,...server};
        (index<WARMUP ? result.warmupRecords : result.records).push(row);
        report("performance-sample",{warmup:index<WARMUP,sample:index<WARMUP ? index+1 : index-WARMUP+1,saveMs:Math.round(saveMs),joinMs:Math.round(joinMs)});
      } catch(error) {
        result.failureDiagnostic={...failureContext,ownerSocketState:owner.ws.readyState,guestSocketState:member?.ws.readyState,ownerCloseCode:owner.closeCode,guestCloseCode:member?.closeCode};
        throw error;
      } finally {member?.ws.terminate();if(member)await until(()=>Promise.resolve(member.ws.readyState===3));}
      if(index%10===9)await pause(1000); // No parallel bursts or extra fixture rooms.
    }
    result.completed=true;
  } catch(error) {result.failures++;result.failureDiagnostic??={...failureContext,ownerSocketState:owner.ws.readyState,ownerCloseCode:owner.closeCode};throw error;}
  finally {
    clearInterval(heartbeat);owner.ws.terminate();
    if(dispatcher) await dispatcher.destroy();
    result.finishedAt=new Date().toISOString();
    const fields=["saveMs","joinMs","cryptoMs","uploadMs","presignMs","presignHeadersMs","presignBodyMs","journalMs","providerPutCallbackMs","providerHeadersMs","providerReceiptBodyMs","assetPendingMs","snapshotMs","joinSocketMs","joinSnapshotMs","joinAssetsMs","assetIndexMs","assetDownloadMs","assetDownloadHeadersMs","assetDownloadBodyMs","assetDecodeMs","fanoutMs"];
    if(c.providerDiagnostic) fields.push("repeatedDownloadMs","repeatedDownloadHeadersMs","repeatedDownloadBodyMs");
    if(c.serverDiagnostic) fields.push(...new Set(result.records.flatMap(row=>Object.keys(row).filter(field=>/^(?:presignRoute|presign|callback|index|snapshotWrite|snapshotRead)_/.test(field)))));
    result.metrics=Object.fromEntries(fields.map(field=>[field,summary(result.records.map(row=>row[field]))]));
    result.pendingRatio=result.records.length ? result.records.filter(row=>row.initialPending).length/result.records.length : null;
    result.failureRatio=result.failures/(result.records.length+result.failures || 1);
    result.gatePassed=result.completed && result.records.length===SAMPLES && result.metrics.saveMs.p95<=3000 && result.metrics.saveMs.p99<=8000 && result.metrics.joinMs.p95<=3000 && result.metrics.joinMs.p99<=5000;
    report("performance-summary",{completed:result.completed,gatePassed:result.gatePassed,save:result.metrics.saveMs,join:result.metrics.joinMs});
  }
  return result;
}
