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
import { createMaxMemoryWatchdog, MAX_RELAY_RSS_BYTES } from "./watchdog.ts";

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
// The deployment envelope's declaration: one instance is the whole
// service, so these limits *are* the service's capacity and availability
// ceiling (SLO §0) — stated at startup rather than left as an assumption.
logger.info("relay.single_instance", {
  instances: 1,
  maxConnections: server.limits.maxConnections,
  maxRooms: server.limits.maxRooms,
  maxConnectionsPerRoom: server.limits.maxConnectionsPerRoom,
  drainTimeoutMs: server.limits.drainTimeoutMs,
  maxRssBytes: MAX_RELAY_RSS_BYTES,
});

/**
 * Every way out of the process goes through the same graceful drain: existing
 * connections close with a retryable code inside a bounded window, so clients
 * rejoin the replacement process instead of experiencing a mass 1006. The
 * guard makes the exits compose — a SIGTERM landing mid-watchdog-drain (or a
 * second SIGTERM) must not restart the sequence or race two exits.
 */
let shuttingDown = false;
const shutdown = (exitCode: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  watchdog.stop();
  void server
    .drain()
    .then(() => server.close())
    .then(() => process.exit(exitCode));
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// A non-zero exit distinguishes the memory-triggered restart from an ordered
// shutdown in the process manager's log; the manager restarts either way.
const watchdog = createMaxMemoryWatchdog({
  logger,
  onExceeded: () => shutdown(1),
});
