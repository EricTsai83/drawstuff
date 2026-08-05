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
  type RelayConnectionLimits,
} from "./connection.ts";
import { createRelayControlRequestHandler } from "./control.ts";
import { createInMemoryRoomFanout, type RoomFanout } from "./fanout.ts";
import {
  createSubjectRateLimiter,
  DEFAULT_RELAY_RATE_LIMITS,
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

  const httpServer: Server = createServer(
    createRelayControlRequestHandler({ sessions, joinTokenSecret }),
  );
  const server = new WebSocketServer({
    server: httpServer,
    // Transport-level cap; exact per-channel budgets are enforced per frame.
    maxPayload: MAX_RELAY_DATA_FRAME_BYTES,
  });
  httpServer.listen(options.port ?? 0, host);
  await once(httpServer, "listening");

  const liveness = new WeakMap<WebSocket, { isAlive: boolean }>();

  server.on("connection", (socket) => {
    if (server.clients.size > limits.maxConnections) {
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

    const state = { isAlive: true };
    liveness.set(socket, state);
    socket.on("pong", () => {
      state.isAlive = true;
    });

    const connection = createRelayConnection({
      socket,
      fanout,
      sessions,
      limits,
      subjectRateLimiter,
      generatePeerId,
      joinTokenSecret,
    });

    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (isBinary) {
        connection.handleBinaryFrame(new Uint8Array(bytes));
      } else {
        connection.handleTextFrame(bytes.toString("utf8"));
      }
    });
    socket.on("close", () => {
      connection.handleSocketClosed();
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
        socket.terminate();
        continue;
      }
      state.isAlive = false;
      socket.ping();
    }
  }, limits.heartbeatIntervalMs);

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
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      // Terminating (not closing) makes shutdown deterministic: 'close'
      // events still fire, releasing every room membership via the
      // connection cleanup path.
      for (const socket of server.clients) {
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
    },
  };
}
