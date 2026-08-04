import {
  decodeCollaborationMessage,
  encodeCollaborationMessage,
} from "./codec.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  type ClientId,
  type CollaborationMessage,
  type PeerId,
  type RoomId,
} from "./messages.ts";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayServerControl,
} from "./relay-protocol.ts";
import { roomRoleCanEditScene, type RoomRole } from "./room-auth.ts";
import type {
  CollaborationTransport,
  ConnectionState,
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
  onclose: ((event: unknown) => void) | null;
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
  /** Relay WebSocket endpoint, e.g. `ws://127.0.0.1:3005`. */
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
    roomId: RoomId;
    clientId: ClientId;
    session?: { peerId: PeerId; roomGeneration: number; role: RoomRole };
  };

  const subscribers = new Set<TransportSubscriber>();
  let active: ActiveConnection | undefined;
  let closed = false;

  const connectionState = (): ConnectionState => {
    if (closed) return { status: "closed" };
    if (!active) return { status: "disconnected" };
    if (!active.session) return { status: "connecting", roomId: active.roomId };
    return {
      status: "connected",
      roomId: active.roomId,
      clientId: active.clientId,
      peerId: active.session.peerId,
      roomGeneration: active.session.roomGeneration,
      role: active.session.role,
    };
  };

  const notifyConnectionState = (): void => {
    const state = connectionState();
    for (const subscriber of subscribers) {
      subscriber.onConnectionStateChange?.(state);
    }
  };

  const notifyRoomPeers = (peers: readonly RoomPeer[]): void => {
    for (const subscriber of subscribers) {
      subscriber.onRoomPeersChange?.(peers);
    }
  };

  const detachSocket = (socket: RelaySocketLike): void => {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  };

  /** Drop the current connection and report `disconnected` (unless closed). */
  const teardown = (connection: ActiveConnection): void => {
    if (active !== connection) return;
    active = undefined;
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
      if (connection.session || control.roomId !== connection.roomId) {
        teardown(connection);
        return;
      }
      connection.session = {
        peerId: control.peerId,
        roomGeneration: control.roomGeneration,
        role: control.role,
      };
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
    const decoded = decodeCollaborationMessage(
      dataFrame.payload,
      dataFrame.channel,
    );
    // Malformed or oversize payloads are another client's protocol violation;
    // this receiver drops them and converges via scene-init snapshots.
    if (!decoded.ok) return;
    for (const subscriber of subscribers) {
      subscriber.onMessage?.(decoded.message);
    }
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
      message.senderClientId !== connection.clientId ||
      message.senderPeerId !== connection.session.peerId ||
      message.roomGeneration !== connection.session.roomGeneration
    ) {
      return { ok: false, error: { code: "stale-session" } };
    }
    const encoded = encodeCollaborationMessage(message);
    if (!encoded.ok) return encoded;
    const frame = encodeRelayDataFrame(channel, encoded.bytes);
    // Backpressure bound: the socket buffer is the only outbound queue, and
    // it must never grow without limit. Scene senders re-extract and retry;
    // presence is volatile and simply lost.
    if (
      connection.socket.bufferedAmount + frame.byteLength >
      maxBufferedBytes
    ) {
      return { ok: false, error: { code: "queue-overflow" } };
    }
    connection.socket.send(frame);
    return { ok: true };
  };

  return {
    getConnectionState: connectionState,
    connect({ roomId, clientId, joinToken }) {
      if (closed) throw new Error("Transport is closed");
      if (active) throw new Error("Transport is already connected");
      if (joinToken.length === 0) {
        throw new Error("A room join token is required to connect");
      }

      const socket = createSocket(url);
      socket.binaryType = "arraybuffer";
      const connection: ActiveConnection = { socket, roomId, clientId };
      active = connection;

      socket.onopen = () => {
        if (active !== connection) return;
        socket.send(
          encodeRelayControl({
            control: "join",
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            roomId,
            clientId,
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
      socket.onclose = () => {
        if (active !== connection) return;
        active = undefined;
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
      teardown(connection);
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
      if (connection) teardown(connection);
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
