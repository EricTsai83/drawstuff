import {
  assertRoomTokenSecret,
  MIN_ROOM_TOKEN_SECRET_BYTES,
} from "@drawstuff/collaboration/room-token";

import { RELAY_CONTROL_PATH } from "./control.ts";
import { createRelayServer } from "./server.ts";

/**
 * Local/test entry point. Production deployment and multi-instance fanout stay
 * out of scope until Plan 19.
 */
const port = Number(process.env.PORT ?? "3005");
const host = process.env.HOST ?? "127.0.0.1";

/**
 * The relay refuses to start without the room token secret it shares with the
 * app: an unauthenticated relay would accept any join, so this is a hard
 * startup requirement rather than an optional feature switch.
 */
const joinTokenSecret = process.env.COLLAB_JOIN_TOKEN_SECRET ?? "";
try {
  assertRoomTokenSecret(joinTokenSecret);
} catch {
  console.error(
    "COLLAB_JOIN_TOKEN_SECRET is required (min " +
      `${MIN_ROOM_TOKEN_SECRET_BYTES} bytes, shared with the Drawstuff app)`,
  );
  process.exit(1);
}

const server = await createRelayServer({ port, host, joinTokenSecret });
// The cross-process integration test parses this line to learn the port.
console.log(`collaboration-relay listening on ${server.url}`);
console.log(`room control endpoint ${server.controlUrl}${RELAY_CONTROL_PATH}`);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
