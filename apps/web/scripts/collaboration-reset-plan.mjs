/** Generates reviewable SQL only. Never reads DATABASE_URL or opens a connection. */
import {createJiti} from "jiti";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
const web=resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":resolve(web,"src")}});
const schema=await jiti.import(resolve(web,"src/server/db/schema.ts"));
const legacy=await jiti.import(resolve(web,"tests/support/legacy-collaboration-schema.ts"));
const {collaborationDDL,resetDDL}=await jiti.import(resolve(web,"scripts/collaboration-reset-ddl.ts"));
const current=await collaborationDDL(schema);
const previous=await collaborationDDL(legacy);
const names=[...current.names,...previous.names];
const destination=resolve(web,"../../docs/deployment/collaboration-reset");
await mkdir(destination,{recursive:true});
for(const [name,ddl] of [["upgrade.sql",current],["rollback.sql",previous]]) {
  await writeFile(resolve(destination,name),`-- Generated collaboration-only reset. Run ONLY in the P3 isolated maintenance window.\n-- Export cleanup manifests and stop all writers before this transaction. No object deletion here.\nBEGIN;\n${resetDDL(names,ddl.statements).join("\n")}\nCOMMIT;\n`);
}
console.log("Generated collaboration-only upgrade and rollback SQL; no database accessed.");
