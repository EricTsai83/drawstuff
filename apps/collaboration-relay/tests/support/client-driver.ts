import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";

import { createTestClient } from "./test-client.ts";

/**
 * Cross-process collaboration client for the relay integration test. The
 * parent process reads line-oriented stdout: `ready` once joined, then a
 * `digest\t<json>` line whenever the local element store changes.
 */
const url = process.env.RELAY_URL;
const roomIdRaw = process.env.RELAY_ROOM_ID;
const clientIdRaw = process.env.RELAY_CLIENT_ID;
const nonceSeed = Number(process.env.RELAY_NONCE_SEED ?? "1");
const elementPrefix = process.env.RELAY_ELEMENT_PREFIX ?? "el-driver";
const elementCount = Number(process.env.RELAY_ELEMENT_COUNT ?? "3");

if (!url || !roomIdRaw || !clientIdRaw) {
  throw new Error("RELAY_URL, RELAY_ROOM_ID, and RELAY_CLIENT_ID are required");
}

const client = createTestClient({
  url,
  roomId: roomIdSchema.parse(roomIdRaw),
  clientId: clientIdSchema.parse(clientIdRaw),
  nonceSeed,
});

await client.connect();
console.log("ready");

for (let index = 0; index < elementCount; index += 1) {
  client.upsertElement(`${elementPrefix}-${index}`, `from-${clientIdRaw}`);
}

let lastDigest = "";
const reportTimer = setInterval(() => {
  const digest = client.digest();
  if (digest !== lastDigest) {
    lastDigest = digest;
    console.log(`digest\t${digest}`);
  }
}, 25);

const shutdown = (): void => {
  clearInterval(reportTimer);
  client.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
