import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { peerIdSchema, type PeerId } from "@drawstuff/collaboration/protocol";
import {
  MAX_RELAY_CONTROL_FRAME_BYTES,
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
  /**
   * Upper bound of the graceful-drain window. A drained socket that
   * has not finished its close handshake by this deadline is terminated and
   * counted — the drain must end, or a stuck peer would turn every restart
   * into an operator judgement call.
   */
  drainTimeoutMs: number;
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
  // A close handshake normally completes within one round trip, so 10 s is
  // generous headroom, and it stays well inside the process manager's
  // kill timeout (see `pm2.config.cjs`) so SIGTERM never escalates to SIGKILL
  // while sockets are still closing.
  drainTimeoutMs: 10_000,
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
  /**
   * Grace a refused socket gets to finish its close handshake before it is
   * terminated outright; defaults to {@link CAPACITY_REJECT_GRACE_MS}. Tests
   * shorten it so the force-terminate path is observable without real waits.
   */
  capacityRejectGraceMs?: number;
  generatePeerId?: () => PeerId;
  /** Structured log sink; defaults to JSON lines on stdout. */
  logger?: RelayLogger;
};

export type RelayServer = {
  readonly port: number;
  readonly url: string;
  /** HTTP origin of the server-to-server control endpoint. */
  readonly controlUrl: string;
  /** Effective limits, for the deployment envelope's startup declaration. */
  readonly limits: Readonly<RelayLimits>;
  connectionCount(): number;
  roomCount(): number;
  /** Authorized, currently joined sessions across all room generations. */
  sessionCount(): number;
  /**
   * Marks the process unhealthy at `/healthz` so a rolling restart can hand
   * traffic over before this instance stops accepting it. Idempotent.
   *
   * Health reporting is all this does. Releasing the
   * connections that are still attached is `drain()`.
   */
  beginDrain(): void;
  /**
   * The graceful-drain sequence: reports unhealthy, refuses new
   * connections, and closes every attached connection with the retryable
   * `relayRestarting` close code so clients rejoin the replacement process
   * through their recovery backoff. Resolves once every connection present at
   * drain start has closed, or at `drainTimeoutMs`, when the stragglers are
   * terminated and counted — never later. Idempotent: every caller gets the
   * same drain.
   */
  drain(): Promise<void>;
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
 * Authorization is token-based: every join must present a short-lived
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
   * Once true the process is on its way out: `/healthz` reports unhealthy, new
   * connections are refused with the retryable `relayRestarting` code, and
   * `drain()` is releasing (or has released) the attached ones. `close()`
   * enters it too, so a shutdown never reports itself healthy on the way out.
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
  httpServer.listen(options.port ?? 0, host);
  // Attached only after the bind succeeded: `ws` re-emits the HTTP server's
  // 'error' events on the WebSocketServer, where nothing listens — so an
  // EADDRINUSE during startup would throw uncaught before this function's own
  // rejection (via `once`) could reach the caller's structured error handling.
  await once(httpServer, "listening");
  const server = new WebSocketServer({
    server: httpServer,
    // Transport-level cap; exact per-channel budgets are enforced per frame.
    maxPayload: MAX_RELAY_DATA_FRAME_BYTES,
  });

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

  /**
   * Closes a socket the relay refuses to serve, without creating connection
   * state for it. ws keeps a closing socket tracked for up to 30s waiting for
   * the close handshake, and refused sockets have no heartbeat state, so an
   * unresponsive flood could grow the tracked set far past the cap;
   * force-terminate on a short deadline instead.
   */
  const capacityRejectGraceMs =
    options.capacityRejectGraceMs ?? CAPACITY_REJECT_GRACE_MS;
  const refuseConnection = (
    socket: WebSocket,
    closeCode: number,
    reason: string,
  ): void => {
    socket.close(closeCode, reason);
    const forceTerminate = setTimeout(
      () => socket.terminate(),
      capacityRejectGraceMs,
    );
    socket.once("close", () => clearTimeout(forceTerminate));
  };

  server.on("connection", (socket) => {
    metrics.connectionOpened();
    // Refusing before the capacity check: a draining process must not admit a
    // connection it is about to close again, whatever its occupancy. The code
    // is retryable, so the client's recovery backoff carries it to the
    // replacement process rather than ending its session.
    if (draining) {
      metrics.connectionClosed("relayRestarting");
      logger.info("relay.connection_rejected", {
        closeCode: RELAY_CLOSE_CODES.relayRestarting,
        closeReason: "relayRestarting",
        connections: server.clients.size,
      });
      refuseConnection(
        socket,
        RELAY_CLOSE_CODES.relayRestarting,
        "relay restarting",
      );
      return;
    }
    if (server.clients.size > limits.maxConnections) {
      metrics.connectionClosed("relayAtCapacity");
      logger.warn("relay.connection_rejected", {
        closeCode: RELAY_CLOSE_CODES.relayAtCapacity,
        closeReason: "relayAtCapacity",
        connections: server.clients.size,
        limit: limits.maxConnections,
      });
      refuseConnection(
        socket,
        RELAY_CLOSE_CODES.relayAtCapacity,
        "relay at capacity",
      );
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
      try {
        if (isBinary) {
          connection.handleBinaryFrame(new Uint8Array(bytes), receivedAt);
        } else {
          // Raw wire bytes first: ws's `maxPayload` admits text frames up to
          // the much larger scene budget, so without this check an over-budget
          // control frame buys a full UTF-8 decode before it is refused.
          if (bytes.length > MAX_RELAY_CONTROL_FRAME_BYTES) {
            connection.close(
              RELAY_CLOSE_CODES.protocolViolation,
              "oversize control frame",
            );
            return;
          }
          connection.handleTextFrame(bytes.toString("utf8"));
        }
      } catch {
        // Last line of defense for the frame path: a throw anywhere above must
        // cost this connection, never the process — an escaped exception here
        // is the mass 1006 disconnect `main.ts` promises cannot happen. The
        // error object itself is not loggable (the structured log's field set
        // is closed), so the record carries the event alone.
        logger.error("relay.frame_dispatch_failed", {
          closeCode: RELAY_CLOSE_CODES.internalError,
        });
        try {
          connection.close(RELAY_CLOSE_CODES.internalError, "internal error");
        } catch {
          socket.terminate();
        }
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

  const beginDrain = (): void => {
    if (draining) return;
    draining = true;
    logger.info("relay.draining", {
      connections: server.clients.size,
      rooms: fanout.roomCount(),
      sessions: sessions.sessionCount(),
    });
  };

  let drained: Promise<void> | undefined;

  /**
   * See {@link RelayServer.drain}. The bounded window waits on exactly the
   * sockets present at drain start: a connection arriving mid-drain is refused
   * with its own short force-terminate deadline, and waiting on it here would
   * let a stream of doomed newcomers extend the drain without bound.
   */
  const drain = (): Promise<void> => {
    drained ??= (async () => {
      beginDrain();
      const startedAt = monotonicNow();
      const pending = new Set(server.clients);
      let forcedTerminations = 0;
      const closing = pending.size;
      await new Promise<void>((resolve) => {
        if (pending.size === 0) {
          resolve();
          return;
        }
        const deadline = setTimeout(() => {
          // Anything still pending genuinely sat out the whole window: every
          // close — graceful, heartbeat, peer-initiated — lands in `settle`.
          // The close was already recorded as `relayRestarting` below, so the
          // terminate is transport-level force only, counted here and in the
          // `relay.drained` record rather than as a second disconnect.
          forcedTerminations = pending.size;
          for (const socket of pending) {
            socket.terminate();
          }
          resolve();
        }, limits.drainTimeoutMs);
        const settle = (socket: WebSocket): void => {
          pending.delete(socket);
          if (pending.size === 0) {
            clearTimeout(deadline);
            resolve();
          }
        };
        // Two phases on purpose. Closing a connection releases its room
        // membership, and that release *synchronously* broadcasts the new peer
        // list to the room's remaining members — a cascade that could close a
        // still-open, over-budget member as a slow consumer before this loop
        // reached it. Putting every socket into CLOSING first makes the
        // cascade inert (`deliverPeers` skips non-open sockets), so phase two
        // can attribute each close as `relayRestarting`, undisturbed.
        for (const socket of pending) {
          socket.once("close", () => settle(socket));
          socket.close(RELAY_CLOSE_CODES.relayRestarting, "relay restarting");
        }
        for (const socket of pending) {
          // Through the connection, not just the socket: `RelayConnection.close`
          // records reason and close code together and releases the
          // connection's own deadlines, so no competing close path (join
          // deadline, idle budget, revocation) can re-attribute this
          // disconnect mid-drain. Only a capacity-refused socket still inside
          // its refusal grace has no connection; its close was recorded when
          // it was refused.
          liveness
            .get(socket)
            ?.connection.close(
              RELAY_CLOSE_CODES.relayRestarting,
              "relay restarting",
            );
        }
      });
      logger.info("relay.drained", {
        connections: closing,
        forcedTerminations,
        durationMs: Math.round(monotonicNow() - startedAt),
      });
    })();
    return drained;
  };

  return {
    port,
    url: `ws://${host}:${port}`,
    controlUrl: `http://${host}:${port}`,
    limits,
    connectionCount: () => server.clients.size,
    roomCount: () => fanout.roomCount(),
    sessionCount: () => sessions.sessionCount(),
    beginDrain,
    drain,
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
