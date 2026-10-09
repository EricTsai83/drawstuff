import { KEEPALIVE_INTERVAL_MS } from "./client-pacing.ts";
import {
  decodeCollaborationMessage,
  encodeCollaborationMessage,
} from "./codec.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  type CollaborationMessage,
  type PeerId,
  type RoomId,
} from "./messages.ts";
import {
  decodeRelayDataFrame,
  disconnectReasonForCloseCode,
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayServerControl,
  RELAY_KEEPALIVE_REQUEST,
} from "./relay-protocol.ts";
import { roomRoleCanEditScene, type RoomRole } from "./room-auth.ts";
import type {
  CollaborationTransport,
  ConnectionState,
  DisconnectReason,
  RoomPeer,
  SendResult,
  TransportSubscriber,
} from "./transport.ts";
import type { MessageChannel } from "./codec.ts";

/**
 * The slice of the standard `WebSocket` interface the transport uses. Both
 * browser `WebSocket` and Node's global (undici) `WebSocket` satisfy it;
 * tests inject a deterministic fake.
 */
export type RelaySocketLike = {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  /**
   * `CloseEvent`, narrowed to the one field recovery needs. The relay states
   * *why* it closed a connection in the close code (`RELAY_CLOSE_CODES`), and
   * without it a revoked membership is indistinguishable from a network blip —
   * so the reconnect loop would retry both.
   */
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

const WEB_SOCKET_OPEN = 1;

/**
 * Outbound backpressure bound: sends fail with `queue-overflow` once the
 * socket buffer holds this many undrained bytes. Sized for a handful of
 * maximum-size scene snapshots.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1_048_576;

export type RelayWebSocketTransportOptions = {
  /** Realtime WebSocket endpoint (server-composed, opaque to the client). */
  url: string;
  /** Injectable socket constructor; defaults to the global `WebSocket`. */
  createSocket?: (url: string) => RelaySocketLike;
  maxBufferedBytes?: number;
};

/**
 * `CollaborationTransport` backed by one WebSocket connection to the relay.
 *
 * Session identity (`peerId`, `roomGeneration`) is assigned by the relay in
 * the `joined` acknowledgment, so the transport reports `connecting` until
 * the join round-trip completes. A socket close in any state degrades to
 * `disconnected`; reconnecting is the caller's decision via `connect()`.
 *
 * Frames carry encoded messages (WSS protects them in transit), so sending and
 * receiving are synchronous and keep the protocol's session ordering by
 * construction.
 */
export function createRelayWebSocketTransport(
  options: RelayWebSocketTransportOptions,
): CollaborationTransport {
  const { url, maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES } = options;
  const createSocket =
    options.createSocket ??
    ((socketUrl: string): RelaySocketLike =>
      new WebSocket(socketUrl) as unknown as RelaySocketLike);

  type ActiveConnection = {
    socket: RelaySocketLike;
    keepalive?: ReturnType<typeof setInterval>;
    roomId: RoomId;
    session?: { peerId: PeerId; roomGeneration: number; role: RoomRole };
  };

  const subscribers = new Set<TransportSubscriber>();

  /**
   * Every fanout goes through here so one subscriber's throw cannot starve
   * the subscribers after it of the same notification.
   */
  const notifySubscribers = (
    notify: (subscriber: TransportSubscriber) => void,
  ): void => {
    for (const subscriber of subscribers) {
      try {
        notify(subscriber);
      } catch {
        // The subscriber's failure is its own; delivery to the rest goes on.
      }
    }
  };
  let active: ActiveConnection | undefined;
  let closed = false;
  /**
   * Why the last connection ended, reported with every `disconnected` state so a
   * caller never has to guess whether reconnecting is the right move. Reset on
   * `connect()` so a stale reason cannot outlive the connection it describes.
   */
  let disconnectReason: DisconnectReason = "idle";

  const connectionState = (): ConnectionState => {
    if (closed) return { status: "closed" };
    if (!active) return { status: "disconnected", reason: disconnectReason };
    if (!active.session) return { status: "connecting", roomId: active.roomId };
    return {
      status: "connected",
      roomId: active.roomId,
      peerId: active.session.peerId,
      roomGeneration: active.session.roomGeneration,
      role: active.session.role,
    };
  };

  const notifyConnectionState = (): void => {
    const state = connectionState();
    notifySubscribers((subscriber) =>
      subscriber.onConnectionStateChange?.(state),
    );
  };

  const notifyRoomPeers = (peers: readonly RoomPeer[]): void => {
    notifySubscribers((subscriber) => subscriber.onRoomPeersChange?.(peers));
  };

  const detachSocket = (socket: RelaySocketLike): void => {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  };

  /** Drop the current connection and report `disconnected` (unless closed). */
  const teardown = (
    connection: ActiveConnection,
    reason: DisconnectReason,
  ): void => {
    if (active !== connection) return;
    active = undefined;
    disconnectReason = reason;
    clearInterval(connection.keepalive);
    detachSocket(connection.socket);
    try {
      connection.socket.close(1000, "client disconnect");
    } catch {
      // Closing an already-failed socket must not break the state machine.
    }
    notifyConnectionState();
  };

  const handleServerText = (
    connection: ActiveConnection,
    text: string,
  ): void => {
    const control = parseRelayServerControl(text);
    if (!control) return;
    if (control.control === "joined") {
      // A second `joined` or one for the wrong room is a relay bug; treat it
      // as a broken connection rather than adopting inconsistent identity.
      // Reported as a protocol failure, not a blip: reconnecting into a relay
      // that answers this way would only repeat it.
      if (connection.session || control.roomId !== connection.roomId) {
        teardown(connection, "protocol");
        return;
      }
      connection.session = {
        peerId: control.peerId,
        roomGeneration: control.roomGeneration,
        role: control.role,
      };
      // Liveness only: this byte-exact frame is not a data frame and does
      // not count as room activity. Auto-response ACKs are optional.
      connection.keepalive = setInterval(() => {
        if (active !== connection) return;
        if (connection.socket.readyState !== WEB_SOCKET_OPEN) {
          teardown(connection, "transient");
          return;
        }
        try {
          connection.socket.send(RELAY_KEEPALIVE_REQUEST);
        } catch {
          teardown(connection, "transient");
        }
      }, KEEPALIVE_INTERVAL_MS);
      notifyConnectionState();
      notifyRoomPeers(control.peers);
      return;
    }
    if (connection.session) {
      notifyRoomPeers(control.peers);
    }
  };

  const handleServerData = (
    connection: ActiveConnection,
    frame: Uint8Array,
  ): void => {
    if (!connection.session) return;
    const dataFrame = decodeRelayDataFrame(frame);
    if (!dataFrame) return;
    const { channel, payload } = dataFrame;
    const decoded = decodeCollaborationMessage(payload, channel);
    // Malformed or oversize payloads are another client's protocol violation;
    // this receiver drops them and converges via scene-init snapshots.
    if (!decoded.ok) return;
    notifySubscribers((subscriber) =>
      subscriber.onMessage?.(decoded.message, {
        byteLength: payload.byteLength,
      }),
    );
  };

  const toBytes = (data: unknown): Uint8Array | undefined => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return undefined;
  };

  const send = (
    message: CollaborationMessage,
    channel: MessageChannel,
  ): SendResult => {
    const connection = active;
    if (closed || !connection?.session) {
      return { ok: false, error: { code: "not-connected" } };
    }
    // The relay closes a viewer's connection outright when it publishes on the
    // scene channel. Failing the send here keeps a mis-wired caller from
    // destroying its own read-only session; enforcement stays server-side.
    if (channel === "scene" && !roomRoleCanEditScene(connection.session.role)) {
      return { ok: false, error: { code: "read-only-role" } };
    }
    if (
      message.roomId !== connection.roomId ||
      message.senderPeerId !== connection.session.peerId ||
      message.roomGeneration !== connection.session.roomGeneration
    ) {
      return { ok: false, error: { code: "stale-session" } };
    }
    const encoded = encodeCollaborationMessage(message);
    if (!encoded.ok) return encoded;
    const frame = encodeRelayDataFrame(channel, encoded.bytes);
    // Backpressure bound: the socket buffer is the only outbound queue, and it
    // must never grow without limit. Scene senders re-extract and retry;
    // presence is volatile and lost.
    if (
      connection.socket.bufferedAmount + frame.byteLength >
      maxBufferedBytes
    ) {
      return { ok: false, error: { code: "queue-overflow" } };
    }
    try {
      connection.socket.send(frame);
    } catch {
      // The socket fires `close` after a failed send; teardown happens there.
      return { ok: false, error: { code: "not-connected" } };
    }
    return { ok: true };
  };

  return {
    getConnectionState: connectionState,
    connect({ roomId, joinToken }) {
      if (closed) throw new Error("Transport is closed");
      if (active) throw new Error("Transport is already connected");
      if (joinToken.length === 0) {
        throw new Error("A room identity proof is required to connect");
      }

      const socket = createSocket(url);
      socket.binaryType = "arraybuffer";
      disconnectReason = "idle";
      const connection: ActiveConnection = { socket, roomId };
      active = connection;

      socket.onopen = () => {
        if (active !== connection) return;
        socket.send(
          encodeRelayControl({
            control: "join",
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            roomId,
            token: joinToken,
          }),
        );
      };
      socket.onmessage = (event) => {
        if (active !== connection) return;
        if (typeof event.data === "string") {
          handleServerText(connection, event.data);
          return;
        }
        const bytes = toBytes(event.data);
        if (bytes) handleServerData(connection, bytes);
      };
      socket.onclose = (event) => {
        if (active !== connection) return;
        active = undefined;
        // The relay's close code is the only evidence of *why* the session
        // ended. A missing code (a socket that failed before any close frame)
        // reads as transient, which is what a network failure is.
        disconnectReason = disconnectReasonForCloseCode(event?.code);
        clearInterval(connection.keepalive);
        detachSocket(socket);
        notifyConnectionState();
      };
      socket.onerror = () => {
        // The socket fires `close` after `error`; teardown happens there.
      };

      notifyConnectionState();
    },
    disconnect() {
      const connection = active;
      if (!connection) return;
      if (connection.socket.readyState === WEB_SOCKET_OPEN) {
        try {
          connection.socket.send(encodeRelayControl({ control: "leave" }));
        } catch {
          // Best-effort retraction; the relay also cleans up on close.
        }
      }
      teardown(connection, "idle");
    },
    close() {
      if (closed) return;
      const connection = active;
      if (connection?.socket.readyState === WEB_SOCKET_OPEN) {
        try {
          connection.socket.send(encodeRelayControl({ control: "leave" }));
        } catch {
          // Best-effort retraction; the relay also cleans up on close.
        }
      }
      if (connection) teardown(connection, "idle");
      closed = true;
      notifyConnectionState();
      subscribers.clear();
    },
    sendSceneMessage: (message) => send(message, "scene"),
    sendPresenceMessage: (message) => send(message, "presence"),
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}
