#!/usr/bin/env node
/** Actual production Gateway/Room/Lifecycle in ephemeral workerd; isolated adapter fixture. */
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {unstable_startWorker} from "wrangler";
import {runProductHarness} from "./product-harness.mjs";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const identitySecret="fixture-identity-secret-0000000000000001",serviceSecret="fixture-service-secret-00000000000000001";
let worker;
try{
 worker=await unstable_startWorker({config:join(root,"wrangler.jsonc"),entrypoint:join(root,"tests/support/product-worker.ts"),bindings:Object.fromEntries(Object.entries({COLLAB_IDENTITY_SECRET:identitySecret,COLLAB_AUTHORITY_SECRET:serviceSecret,COLLAB_ADAPTER_SECRET:serviceSecret,COLLAB_ADAPTER_URL:"https://fixture-adapter.test/api/internal/collaboration/adapter"}).map(([name,value])=>[name,{type:"plain_text",value}])),dev:{inspector:false,logLevel:"error",persist:false,remote:false,server:{hostname:"127.0.0.1",port:0},structuredLogsHandler:()=>{},watch:false},sendMetrics:false});
 await worker.ready;const base=(await worker.url).origin;
 await runProductHarness({base,owner:{subject:"fixture-owner",email:"owner@example.com",lifecycleVersion:1},guest:{subject:"fixture-guest",email:"guest@example.com",lifecycleVersion:1},identitySecret,serviceSecret,retire:true,samples:3,advance:async body=>{const response=await fetch(`${base}/__fixture/advance`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});if(response.status!==200)throw new Error(`fixture advance ${response.status}`);}});
}finally{await worker?.dispose();}
