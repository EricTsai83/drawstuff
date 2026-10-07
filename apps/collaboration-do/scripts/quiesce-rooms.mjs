/** Operator-only cutover step. Cancels alarms/closes sockets; preserves all object storage. */
import { readFile } from "node:fs/promises";
import { z } from "zod";

const [base, reportFile, inventoryFile] = process.argv.slice(2);
if (!base || !reportFile || process.argv.length > 5) {
  console.error("Usage: quiesce <https-worker-origin> <before-report.json> [inventory.json]");
  process.exit(1);
}
try {
  const url = new URL(base);
  const secret = process.env.COLLAB_AUTHORITY_SECRET;
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !secret || new TextEncoder().encode(secret).byteLength < 32) throw new Error("Invalid configuration");
  const report = z.object({ phase: z.literal("before"), oldRoomNames: z.array(z.string().regex(/^[a-zA-Z0-9_:@.-]{1,256}$/)) })
    .parse(JSON.parse(await readFile(reportFile, "utf8")));
  const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/));
  const inventory = inventoryFile ? z.strictObject({ roomIds: ids, lifecycleIds: ids }).parse(JSON.parse(await readFile(inventoryFile, "utf8"))) : { roomIds: [], lifecycleIds: [] };
  const rooms = [...new Set(report.oldRoomNames)].map(name => ({ name })).concat([...new Set(inventory.roomIds)].map(id => ({ id })));
  const lifecycles = [...new Set(inventory.lifecycleIds)].map(id => ({ id }));
  for (const [namespace, objects] of [["room", rooms], ["lifecycle", lifecycles]]) {
    for (let offset = 0; offset < objects.length; offset += 16) {
      const batch = objects.slice(offset, offset + 16);
      const response = await fetch(new URL("/internal/cutover/quiesce", url), {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ namespace, objects: batch }),
      });
      if (response.status !== 200 || z.object({ quiesced: z.literal(batch.length) }).safeParse(await response.json()).success !== true) throw new Error("Unacknowledged batch");
    }
  }
  console.log(`Quiesced supplied instances: room=${rooms.length}, lifecycle=${lifecycles.length}. Storage retained. This does not prove inventory completeness.`);
} catch {
  console.error("Quiesce failed; keep maintenance active, check the supplied inventory/configuration and retry. No database or object storage was deleted.");
  process.exitCode = 1;
}
