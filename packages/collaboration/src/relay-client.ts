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
  MIN_REALTIME_SEALED_FRAME_BYTES,
  sealedFrameByteLength,
  type RealtimeCryptoCodec,
} from "./realtime-crypto.ts";
import {
  decodeRelayDataFrame,
  disconnectReasonForCloseCode,
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayServerControl,
  RELAY_DATA_FRAME_HEADER_BYTES,
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

/**
 * Inbound backpressure bound, applied **per channel**: ciphertext waiting to be
 * authenticated. The relay can deliver faster than AES-GCM settles, so without a
 * cap a peer (or a hostile relay) could grow client memory and queued crypto
 * work without limit just by sending.
 *
 * Per channel rather than per direction, unlike the outbound bound. Outbound
 * shares one socket buffer, so charging each channel separately there would let
 * the two together reach twice the bound. Inbound shares only the heap, and
 * isolation is worth more: a presence flood must not be able to starve scene
 * traffic, whose loss is what actually threatens convergence.
 */
export const DEFAULT_MAX_INBOUND_PENDING_BYTES = 2 * 1_048_576;

/**
 * Fixed cost charged per queued inbound frame, on top of its ciphertext bytes.
 *
 * Bytes alone do not bound the queue: every entry also retains a promise and a
 * closure, so a flood of minimum-size frames could pin ~140k queued decryptions
 * inside a byte budget that looks respectable. Charging per entry bounds the
 * count as well — the byte budget divided by this is the real entry ceiling.
 */
export const INBOUND_QUEUE_ENTRY_COST_BYTES = 512;

export type RelayWebSocketTransportOptions = {
  /** Relay WebSocket endpoint, e.g. `ws://127.0.0.1:3005`. */
  url: string;
  /**
   * End-to-end codec for this room generation. Mandatory: there is no
   * plaintext path to the relay, so a caller cannot accidentally publish
   * readable scene or presence state by omitting encryption.
   */
  crypto: RealtimeCryptoCodec;
  /** Injectable socket constructor; defaults to the global `WebSocket`. */
  createSocket?: (url: string) => RelaySocketLike;
  maxBufferedBytes?: number;
  /** Per-channel inbound bound; see `DEFAULT_MAX_INBOUND_PENDING_BYTES`. */
  maxInboundPendingBytes?: number;
};

/**
 * `CollaborationTransport` backed by one WebSocket connection to the relay.
 *
 * Session identity (`peerId`, `roomGeneration`) is assigned by the relay in
 * the `joined` acknowledgment, so the transport reports `connecting` until
 * the join round-trip completes. A socket close in any state degrades to
 * `disconnected`; reconnecting is the caller's decision via `connect()`.
 *
 * Web Crypto is asynchronous, so sealing and opening cannot happen inside the
 * synchronous send/receive calls. Each channel therefore owns a promise chain,
 * and both directions are bounded in bytes:
 *
 * - Outbound: `seal` is called at send time so nonces are reserved in send
 *   order, and the chain hands the frames to the socket in that same order.
 * - Inbound: `open` runs *inside* the chain, so authentication and the replay
 *   check happen strictly in wire order. That matters for more than tidiness —
 *   if a duplicate could be authenticated before the original, it would claim
 *   the original's nonce and the original would be dropped as a replay.
 *
 * Both keep the protocol's session-ordering guarantee intact: a reordered scene
 * sequence would otherwise register as a gap and force needless snapshot repair.
 */
export function createRelayWebSocketTransport(
  options: RelayWebSocketTransportOptions,
): CollaborationTransport {
  const {
    url,
    crypto: cryptoCodec,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    maxInboundPendingBytes = DEFAULT_MAX_INBOUND_PENDING_BYTES,
  } = options;
  const createSocket =
    options.createSocket ??
    ((socketUrl: string): RelaySocketLike =>
      new WebSocket(socketUrl) as unknown as RelaySocketLike);

  /** One channel's FIFO chain plus the bytes queued on it. */
  type ChannelQueue = { tail: Promise<void>; pendingBytes: number };
  type ChannelQueues = Record<MessageChannel, ChannelQueue>;
  const newQueues = (): ChannelQueues => ({
    scene: { tail: Promise.resolve(), pendingBytes: 0 },
    presence: { tail: Promise.resolve(), pendingBytes: 0 },
  });

  /**
   * Queues live on the connection, not on the transport. A backlog from a socket
   * that already went away must not charge a new connection's budget, delay its
   * frames behind stale work, or keep consuming crypto after `close()`: dropping
   * the connection drops its queues with it.
   */
  type ActiveConnection = {
    socket: RelaySocketLike;
    roomId: RoomId;
    clientId: ClientId;
    session?: { peerId: PeerId; roomGeneration: number; role: RoomRole };
    /** Sealing, not yet handed to the socket — `bufferedAmount` cannot see it. */
    readonly outbound: ChannelQueues;
    /** Received, not yet authenticated. */
    readonly inbound: ChannelQueues;
  };

  const subscribers = new Set<TransportSubscriber>();
  let active: ActiveConnection | undefined;
  let closed = false;
  /**
   * Why the last connection ended, reported with every `disconnected` state so a
   * caller never has to guess whether reconnecting is the right move. Reset on
   * `connect()` so a stale reason cannot outlive the connection it describes.
   */
  let disconnectReason: DisconnectReason = "idle";

  const totalPendingBytes = (queues: ChannelQueues): number =>
    queues.scene.pendingBytes + queues.presence.pendingBytes;

  const connectionState = (): ConnectionState => {
    if (closed) return { status: "closed" };
    if (!active) return { status: "disconnected", reason: disconnectReason };
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
  const teardown = (
    connection: ActiveConnection,
    reason: DisconnectReason,
  ): void => {
    if (active !== connection) return;
    active = undefined;
    disconnectReason = reason;
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
    const { channel } = dataFrame;
    // Too short to be a sealed frame, so it can only ever fail authentication.
    // Rejected here rather than in the codec so a flood of header-only frames
    // cannot occupy the queue at zero byte cost.
    if (dataFrame.payload.byteLength < MIN_REALTIME_SEALED_FRAME_BYTES) return;

    const queue = connection.inbound[channel];
    // Per-channel inbound bound, charged in ciphertext bytes plus a fixed cost
    // per entry so the queue is bounded in count as well as in size. Over budget
    // the frame is dropped: queueing without limit would let anything that can
    // reach this socket grow memory and crypto work.
    const queueCost =
      dataFrame.payload.byteLength + INBOUND_QUEUE_ENTRY_COST_BYTES;
    if (queue.pendingBytes + queueCost > maxInboundPendingBytes) {
      // Presence is volatile, so losing it is free. A dropped scene frame is
      // not: the receiver would see no sequence gap if that frame was the
      // sender's last, and nothing else would ever trigger a repair. Ask the
      // caller to re-broadcast its own snapshot, which draws the peer's
      // `scene-init` reply and restores convergence.
      if (channel === "scene") {
        for (const subscriber of subscribers) {
          subscriber.onSceneSyncRequired?.();
        }
      }
      return;
    }
    // Copied because the payload now outlives this callback while it waits its
    // turn, and it is only a view onto the socket's message buffer.
    const payload = Uint8Array.from(dataFrame.payload);
    queue.pendingBytes += queueCost;
    queue.tail = queue.tail.then(async () => {
      try {
        // Checked before decrypting, not just before delivering: a backlog left
        // by a socket that already went away must not spend crypto at all.
        if (active !== connection || !connection.session) return;
        // Opened inside the chain, so authentication and the replay check run
        // in wire order. Opening eagerly instead would let a duplicate finish
        // decrypting first, claim the original's nonce, and get the original
        // dropped as the replay.
        const opened = await cryptoCodec.open(payload, channel);
        // A wrong key, tampered ciphertext, or a replayed nonce is dropped
        // silently — there is no plaintext fallback — and the session stays up
        // and converges via scene-init snapshots.
        if (!opened.ok) return;
        if (active !== connection || !connection.session) return;
        const decoded = decodeCollaborationMessage(opened.plaintext, channel);
        // Malformed or oversize payloads are another client's protocol
        // violation; this receiver drops them and converges the same way.
        if (!decoded.ok) return;
        const meta = { byteLength: opened.plaintext.byteLength };
        for (const subscriber of subscribers) {
          subscriber.onMessage?.(decoded.message, meta);
        }
      } catch {
        // A throwing subscriber must not break this channel's delivery order.
      } finally {
        queue.pendingBytes -= queueCost;
      }
    });
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
    // Checked synchronously, immediately before `seal` reserves its nonce:
    // this is what guarantees the session never reuses a nonce instead of
    // discovering the exhaustion after the fact.
    if (!cryptoCodec.canSeal()) {
      return { ok: false, error: { code: "crypto-exhausted" } };
    }

    const queue = connection.outbound[channel];
    const frameByteLength =
      sealedFrameByteLength(encoded.bytes.byteLength) +
      RELAY_DATA_FRAME_HEADER_BYTES;
    // Backpressure bound: the socket buffer plus every frame still sealing is
    // the only outbound queue, and it must never grow without limit. Both
    // channels count against it — they share one socket, so charging each
    // channel separately would let the two of them together reach twice the
    // bound. Scene senders re-extract and retry; presence is volatile and lost.
    if (
      connection.socket.bufferedAmount +
        totalPendingBytes(connection.outbound) +
        frameByteLength >
      maxBufferedBytes
    ) {
      return { ok: false, error: { code: "queue-overflow" } };
    }
    queue.pendingBytes += frameByteLength;
    // Sealing starts here, so nonces are reserved in send order; the chain then
    // hands the frames to the socket in that same order.
    const sealing = cryptoCodec.seal(encoded.bytes, channel);
    queue.tail = queue.tail.then(async () => {
      try {
        const sealed = await sealing;
        // A failed seal drops the message; nothing plaintext is sent instead.
        if (!sealed.ok) return;
        if (active !== connection || !connection.session) return;
        connection.socket.send(encodeRelayDataFrame(channel, sealed.frame));
      } catch {
        // A socket that throws mid-send must not break the channel's chain.
      } finally {
        queue.pendingBytes -= frameByteLength;
      }
    });
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
      disconnectReason = "idle";
      const connection: ActiveConnection = {
        socket,
        roomId,
        clientId,
        outbound: newQueues(),
        inbound: newQueues(),
      };
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
      socket.onclose = (event) => {
        if (active !== connection) return;
        active = undefined;
        // The relay's close code is the only evidence of *why* the session
        // ended. A missing code (a socket that failed before any close frame)
        // reads as transient, which is what a network failure is.
        disconnectReason = disconnectReasonForCloseCode(event?.code);
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
