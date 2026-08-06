import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { peerIdSchema, type PeerId } from "@drawstuff/collaboration/protocol";
import {
  MAX_RELAY_DATA_FRAME_BYTES,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import { assertRoomTokenSecret } from "@drawstuff/collaboration/room-token";

import {
  createRelayConnection,
  type RelayConnection,
  type RelayConnectionLimits,
} from "./connection.ts";
import { createRelayControlRequestHandler } from "./control.ts";
import { createInMemoryRoomFanout, type RoomFanout } from "./fanout.ts";
import { createRelayLogger, type RelayLogger } from "./logger.ts";
import {
  createRelayMetrics,
  type RelayCloseReason,
  type RelayMetrics,
} from "./metrics.ts";
import { createRelayMonitoringRequestHandler } from "./monitoring.ts";
import {
  createSubjectRateLimiter,
  DEFAULT_RELAY_RATE_LIMITS,
  monotonicNow,
  type SubjectRateLimiter,
} from "./rate-limit.ts";
import {
  createRelaySessionRegistry,
  type RelaySessionRegistry,
} from "./sessions.ts";

type RelayLimits = RelayConnectionLimits & {
  /** Relay-wide connection cap; connections beyond it are refused. */
  maxConnections: number;
  /** Ping cadence; a socket that misses one full interval is terminated. */
  heartbeatIntervalMs: number;
};

/** How long a capacity-rejected socket may take to finish the close
 *  handshake before it is terminated outright. */
const CAPACITY_REJECT_GRACE_MS = 5_000;

/**
 * Event-loop lag sampling cadence.
 *
 * The relay's fanout is synchronous, so event-loop lag is the only signal that
 * routing has started to queue (SLO §4.2). 100 ms gives ~300 samples per 30 s,
 * which is what the alert window needs to resolve a p99, while costing one timer
 * for the process.
 */
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 100;

/**
 * Approved in `docs/performance/collaboration-slo-capacity.md` (2026-08-06).
 * Changing any of these requires a new approved revision of that document, not
 * an edit here.
 */
const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxConnections: 256,
  maxConnectionsPerRoom: 32,
  maxRooms: 128,
  maxBufferedBytes: 4 * 1_048_576,
  presenceDropBufferedBytes: 262_144,
  joinTimeoutMs: 10_000,
  idleTimeoutMs: 15 * 60_000,
  heartbeatIntervalMs: 15_000,
  rateLimits: DEFAULT_RELAY_RATE_LIMITS,
};

export type RelayServerOptions = {
  /**
   * Shared secret the app signs room join and control tokens with. Required:
   * the relay has no unauthenticated join path.
   */
  joinTokenSecret: string;
  /** Port to bind; 0 (default) picks an ephemeral port. Local/test only. */
  port?: number;
  host?: string;
  fanout?: RoomFanout;
  sessions?: RelaySessionRegistry;
  limits?: Partial<RelayLimits>;
  /** Join-attempt budget keyed by subject; tests inject one with a manual clock. */
  subjectRateLimiter?: SubjectRateLimiter;
  generatePeerId?: () => PeerId;
  /** Structured log sink; defaults to JSON lines on stdout. */
  logger?: RelayLogger;
};

export type RelayServer = {
  readonly port: number;
  readonly url: string;
  /** HTTP origin of the server-to-server control endpoint. */
  readonly controlUrl: string;
  connectionCount(): number;
  roomCount(): number;
  /** Authorized, currently joined sessions across all room generations. */
  sessionCount(): number;
  /**
   * Marks the process unhealthy at `/healthz` so a rolling restart can hand
   * traffic over before this instance stops accepting it. Idempotent.
   *
   * Health reporting is all this does: releasing the connections that are still
   * attached is the graceful-drain sequence, which is Plan 25's scope. Plan 24
   * owns only the signal, because a probe that reports a departing process as
   * healthy makes every restart look like an outage instead of a handover.
   */
  beginDrain(): void;
  /** Prometheus text exposition, identical to a `/metrics` scrape. */
  renderMetrics(): string;
  close(): Promise<void>;
};

/**
 * Stateless realtime relay. Routes session-ordered scene frames and volatile
 * presence frames between the members of an authorized room; keeps no scene
 * state, no binary payloads, and no persistence — a restart only drops
 * connections and starts fresh room epochs.
 *
 * Authorization is token-based (Plan 13): every join must present a short-lived
 * token signed by the app, and membership changes reach already-connected
 * sockets through the control endpoint served on the same port.
 */
export async function createRelayServer(
  options: RelayServerOptions,
): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  const fanout = options.fanout ?? createInMemoryRoomFanout();
  const sessions = options.sessions ?? createRelaySessionRegistry();
  // Server-owned, not per-connection: the budget it enforces is connect
  // frequency, which only means something across sockets.
  const subjectRateLimiter =
    options.subjectRateLimiter ?? createSubjectRateLimiter();
  // Fail at startup, not on the first join: the secret is only reached inside
  // a socket message handler, where a throw would take the process down.
  const joinTokenSecret = options.joinTokenSecret;
  assertRoomTokenSecret(joinTokenSecret);
  const generatePeerId =
    options.generatePeerId ??
    ((): PeerId => peerIdSchema.parse(`peer-${randomUUID()}`));
  const logger = options.logger ?? createRelayLogger();

  /**
   * Draining is a health-reporting state, not a connection state: it flips
   * `/healthz` to unhealthy so traffic moves elsewhere. `close()` enters it too,
   * so a shutdown never reports itself healthy on the way out.
   */
  let draining = false;
  const metrics: RelayMetrics = createRelayMetrics({
    sources: {
      connections: () => server.clients.size,
      rooms: () => fanout.roomCount(),
      roomSizes: () => fanout.roomSizes(),
      sessions: () => sessions.sessionCount(),
      revocationCutoffs: () => sessions.cutoffCount(),
      trackedSubjects: () => subjectRateLimiter.size(),
      draining: () => draining,
      residentMemoryBytes: () => process.memoryUsage.rss(),
      heapUsedBytes: () => process.memoryUsage().heapUsed,
      droppedLogRecords: () => logger.droppedRecords(),
      rejectedLogFields: () => logger.rejectedFields(),
      limits: {
        maxConnections: limits.maxConnections,
        maxRooms: limits.maxRooms,
        maxConnectionsPerRoom: limits.maxConnectionsPerRoom,
        maxTrackedSubjects: subjectRateLimiter.maxTrackedSubjects,
      },
    },
  });

  const handleMonitoringRequest = createRelayMonitoringRequestHandler({
    metrics,
    isDraining: () => draining,
  });
  const handleControlRequest = createRelayControlRequestHandler({
    sessions,
    joinTokenSecret,
    metrics,
    logger,
  });
  const httpServer: Server = createServer((request, response) => {
    // Monitoring first, and unauthenticated: a scrape or a probe must not depend
    // on the control endpoint's token path being healthy.
    if (handleMonitoringRequest(request, response)) return;
    handleControlRequest(request, response);
  });
  const server = new WebSocketServer({
    server: httpServer,
    // Transport-level cap; exact per-channel budgets are enforced per frame.
    maxPayload: MAX_RELAY_DATA_FRAME_BYTES,
  });
  httpServer.listen(options.port ?? 0, host);
  await once(httpServer, "listening");

  /**
   * Per-socket server-side state. `terminationReason` is how a relay-initiated
   * `terminate()` — which sends no close code — tells the connection why it is
   * going away, so a missed heartbeat and a shutdown stay distinguishable from a
   * peer that simply disconnected.
   */
  type SocketState = {
    isAlive: boolean;
    connection: RelayConnection;
    terminationReason?: RelayCloseReason;
  };
  const liveness = new WeakMap<WebSocket, SocketState>();

  server.on("connection", (socket) => {
    metrics.connectionOpened();
    if (server.clients.size > limits.maxConnections) {
      metrics.connectionClosed("relayAtCapacity");
      logger.warn("relay.connection_rejected", {
        closeCode: RELAY_CLOSE_CODES.relayAtCapacity,
        closeReason: "relayAtCapacity",
        connections: server.clients.size,
        limit: limits.maxConnections,
      });
      socket.close(RELAY_CLOSE_CODES.relayAtCapacity, "relay at capacity");
      // ws keeps a closing socket tracked for up to 30s waiting for the
      // close handshake. Rejected sockets have no heartbeat state, so an
      // unresponsive flood could grow the tracked set far past the cap;
      // force-terminate on a short deadline instead.
      const forceTerminate = setTimeout(
        () => socket.terminate(),
        CAPACITY_REJECT_GRACE_MS,
      );
      socket.once("close", () => clearTimeout(forceTerminate));
      return;
    }

    const connection = createRelayConnection({
      socket,
      fanout,
      sessions,
      limits,
      subjectRateLimiter,
      generatePeerId,
      joinTokenSecret,
      metrics,
      logger,
    });

    const state: SocketState = { isAlive: true, connection };
    liveness.set(socket, state);
    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("message", (data, isBinary) => {
      // Stamped before any decoding, so routing latency is measured from receipt
      // as SLO §3.1 defines it.
      const receivedAt = monotonicNow();
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (isBinary) {
        connection.handleBinaryFrame(new Uint8Array(bytes), receivedAt);
      } else {
        connection.handleTextFrame(bytes.toString("utf8"));
      }
    });
    socket.on("close", () => {
      connection.handleSocketClosed(state.terminationReason);
    });
    socket.on("error", () => {
      // `close` always follows `error`; cleanup happens there.
    });
  });

  // Standard ws heartbeat: one missed pong (no reply within a full interval)
  // marks the socket dead, so every broken connection — and its room
  // membership — is released within a deterministic 2×interval deadline.
  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      const state = liveness.get(socket);
      if (!state) continue;
      if (!state.isAlive) {
        state.terminationReason = "heartbeatTimeout";
        socket.terminate();
        continue;
      }
      state.isAlive = false;
      socket.ping();
    }
  }, limits.heartbeatIntervalMs);

  let lastEventLoopSampleAt = monotonicNow();
  const eventLoopSampler = setInterval(() => {
    const sampledAt = monotonicNow();
    // The interval's overshoot is the lag: how much longer than the nominal
    // period the loop took to come back to this timer.
    const lagMs = Math.max(
      0,
      sampledAt - lastEventLoopSampleAt - EVENT_LOOP_SAMPLE_INTERVAL_MS,
    );
    lastEventLoopSampleAt = sampledAt;
    metrics.observeEventLoopLagSeconds(lagMs / 1_000);
  }, EVENT_LOOP_SAMPLE_INTERVAL_MS);

  const address = httpServer.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  let closed = false;

  return {
    port,
    url: `ws://${host}:${port}`,
    controlUrl: `http://${host}:${port}`,
    connectionCount: () => server.clients.size,
    roomCount: () => fanout.roomCount(),
    sessionCount: () => sessions.sessionCount(),
    beginDrain() {
      if (draining) return;
      draining = true;
      logger.info("relay.draining", {
        connections: server.clients.size,
        rooms: fanout.roomCount(),
        sessions: sessions.sessionCount(),
      });
    },
    renderMetrics: () => metrics.render(),
    async close() {
      if (closed) return;
      closed = true;
      // A process on its way out must not answer a probe with "ok", whether or
      // not anything called `beginDrain()` first.
      draining = true;
      clearInterval(heartbeat);
      clearInterval(eventLoopSampler);
      // Terminating (not closing) makes shutdown deterministic: 'close'
      // events still fire, releasing every room membership via the
      // connection cleanup path.
      for (const socket of server.clients) {
        const state = liveness.get(socket);
        if (state) state.terminationReason = "shutdown";
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // The WebSocket server does not own the HTTP listener it was attached
      // to, so the control endpoint's socket has to be released explicitly.
      // Dropping keep-alive sockets first keeps shutdown deterministic.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      logger.info("relay.stopped");
    },
  };
}
