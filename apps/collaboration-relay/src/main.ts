import {
  assertRoomTokenSecret,
  MIN_ROOM_TOKEN_SECRET_BYTES,
} from "@drawstuff/collaboration/room-token";

import { RELAY_CONTROL_PATH } from "./control.ts";
import {
  createRelayLogger,
  type RelayLogLevel,
  type RelayLogger,
} from "./logger.ts";
import { RELAY_HEALTH_PATH, RELAY_METRICS_PATH } from "./monitoring.ts";
import { createRelayServer } from "./server.ts";

/**
 * Local/test entry point, and the process's configuration boundary: environment
 * variables are read here and nowhere else, so every other module takes its
 * behaviour from arguments.
 */
const port = Number(process.env.PORT ?? "3005");
const host = process.env.HOST ?? "127.0.0.1";

const LOG_LEVELS: readonly RelayLogLevel[] = ["debug", "info", "warn", "error"];
const configuredLevel = process.env.COLLAB_RELAY_LOG_LEVEL;
const level = LOG_LEVELS.find((candidate) => candidate === configuredLevel);

const logger: RelayLogger = createRelayLogger({
  level,
  // Per-frame logging is opt-in and stays off unless an incident needs it; see
  // `RelayLogger.frame`.
  logFrames: process.env.COLLAB_RELAY_LOG_FRAMES === "1",
});

// An unrecognized level falls back to `info`, and says so: a silently ignored
// configuration value is how an operator ends up believing debug logs are on.
if (configuredLevel !== undefined && level === undefined) {
  logger.warn("relay.starting", { configKey: "COLLAB_RELAY_LOG_LEVEL" });
}

/**
 * The relay refuses to start without the room token secret it shares with the
 * app: an unauthenticated relay would accept any join, so this is a hard
 * startup requirement rather than an optional feature switch.
 */
const joinTokenSecret = process.env.COLLAB_JOIN_TOKEN_SECRET ?? "";
try {
  assertRoomTokenSecret(joinTokenSecret);
} catch {
  logger.error("relay.startup_failed", {
    configKey: "COLLAB_JOIN_TOKEN_SECRET",
    limit: MIN_ROOM_TOKEN_SECRET_BYTES,
  });
  process.exit(1);
}

const server = await createRelayServer({ port, host, joinTokenSecret, logger });
// The cross-process integration test reads the `relay.listening` record to learn
// the port; the rest is the endpoint inventory this process now serves.
logger.info("relay.listening", { host, port: server.port, url: server.url });
for (const path of [
  RELAY_CONTROL_PATH,
  RELAY_METRICS_PATH,
  RELAY_HEALTH_PATH,
]) {
  logger.info("relay.endpoint", { path, url: `${server.controlUrl}${path}` });
}

const shutdown = (): void => {
  // Reporting unhealthy before closing is the only ordering that lets a probe
  // observe the handover. The graceful drain of attached connections is Plan 25.
  server.beginDrain();
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
