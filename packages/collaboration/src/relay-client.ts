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

/**
 * Frames that must fail to open, with none ever opening, before the transport
 * reports the room as unreadable (`onRoomUnreadable`).
 *
 * Why this cannot misjudge a healthy session:
 *
 * - **A wrong key fails 100% of the time.** Every frame in a room generation is
 *   sealed under the same derived key, so the failure rate is not a probability
 *   to sample — it is all or nothing. Any threshold is therefore reached as soon
 *   as the room produces that many frames, and a larger one buys no accuracy, it
 *   only delays the message in a quiet room.
 * - **Not one.** A single frame may fail for reasons that are not the key:
 *   corruption in transit, a peer's tampered payload, or a nonce the relay
 *   duplicated. Those must stay silent (there is no plaintext fallback and the
 *   session converges from snapshots), so the smallest usable threshold is one
 *   that a lone bad frame cannot reach.
 * - **Three is reached almost immediately when it is true.** Presence is sent
 *   per pointer sample at ~30/s, and the join handshake alone produces a
 *   `scene-init` from the elected responder, so a room with any live peer
 *   crosses this within a fraction of a second of the first activity.
 * - **One success closes it for good.** The counter only ever runs before the
 *   first successful open, so a long session cannot accumulate its way into a
 *   false verdict.
 */
export const REALTIME_UNREADABLE_FRAME_THRESHOLD = 3;

export type RelayWebSocketTransportOptions = {
  /** Realtime WebSocket endpoint (server-composed, opaque to the client). */
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
    session?: { peerId: PeerId; roomGeneration: number; role: RoomRole };
    /** Sealing, not yet handed to the socket — `bufferedAmount` cannot see it. */
    readonly outbound: ChannelQueues;
    /** Received, not yet authenticated. */
    readonly inbound: ChannelQueues;
    /**
     * A scene drop was already reported and nothing has moved since. One
     * `onSceneSyncRequired` per congestion episode is enough: the repair it
     * requests is a full snapshot exchange, so reporting every dropped frame
     * of the same backlog would only multiply identical full-scene sends into
     * a queue that is already over budget.
     *
     * Re-armed both when the scene queue drains *and* on every delivered
     * scene message. The delivery re-arm matters for the consumer that could
     * not act on the first report — a session holding its join barrier
     * ignores it — because waiting for a full drain would suppress every
     * later drop of the same backlog, and if one of those held the sender's
     * last edit, nothing after the drain would re-report it.
     */
    sceneSyncReported: boolean;
  };

  const subscribers = new Set<TransportSubscriber>();

  /**
   * Every fanout goes through here so one subscriber's throw can neither
   * starve the subscribers after it of the same notification nor — when the
   * notification fires inside a channel chain's `finally` — reject the
   * queue's tail promise and wedge that channel for good.
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

  /**
   * Aggregate evidence for `onRoomUnreadable`: whether any frame has ever
   * opened, and how many have failed while none had.
   *
   * Held on the transport rather than on the connection because the question is
   * about the *key*, which is a property of this transport's codec and outlives
   * every socket it opens. A reconnect that keeps failing keeps accumulating,
   * and a reconnect after a successful open can never re-arm.
   *
   * Bounded by construction: one flag plus one counter that stops the moment the
   * verdict is reported, so this adds no unbounded state to a long session.
   */
  let openedAnyFrame = false;
  let failedFrameOpens = 0;
  let reportedUnreadable = false;
  /**
   * Frames accepted into an inbound queue whose `open` has not settled yet, and
   * the id of the last one admitted.
   *
   * The verdict cannot be taken on the failures alone, because the two channels
   * authenticate on *independent* chains: a valid scene frame can still be
   * decrypting while three small unopenable presence frames finish ahead of it.
   * Reading `openedAnyFrame` at that moment would call a healthy session's key
   * wrong — and the verdict is terminal, so there is no correcting it afterwards.
   */
  let pendingFrameOpens = 0;
  let lastAdmittedFrameId = 0;
  /**
   * The frames the armed verdict is waiting on: exactly those admitted at or
   * before the moment it was armed (`…FenceFrameId`), and how many of them have
   * yet to settle. `-1` means the verdict is not armed.
   *
   * A *cohort*, not "the queues are empty", because the second is not a state a
   * busy room ever has to reach. Waiting for global quiescence would let a room
   * that keeps producing traffic postpone the message indefinitely — a wrong link
   * would stay silent for exactly as long as the room stays interesting, which is
   * the failure this whole detector exists to remove. Frames admitted after the
   * arming moment can only ever be more evidence for the same verdict, so nothing
   * is lost by not waiting for them.
   */
  let verdictFenceFrameId = -1;
  let verdictFenceRemaining = 0;

  /**
   * Records a frame that would not open, and arms the verdict once the failures
   * alone can only mean the key.
   *
   * Deliberately no per-frame reporting: the per-frame policy stays silent (see
   * `handleServerData`), and only the aggregate crosses into the caller.
   */
  const noteFrameOpenFailed = (): void => {
    if (openedAnyFrame || reportedUnreadable) return;
    // Saturating: past the threshold the count answers nothing further, and a
    // counter that kept rising for every frame a wrong link ever receives is
    // exactly the unbounded state this detector promised not to add.
    if (failedFrameOpens < REALTIME_UNREADABLE_FRAME_THRESHOLD) {
      failedFrameOpens += 1;
    }
    if (failedFrameOpens < REALTIME_UNREADABLE_FRAME_THRESHOLD) return;
    if (verdictFenceFrameId >= 0) return;
    // The failing frame is itself still pending — its own settle is what reports
    // the verdict when nothing else was in flight.
    verdictFenceFrameId = lastAdmittedFrameId;
    verdictFenceRemaining = pendingFrameOpens;
  };

  /**
   * Retires one frame from the armed verdict's cohort and reports once the whole
   * cohort has settled.
   *
   * Called after every settled open, so a frame that succeeds while the verdict
   * is armed cancels it permanently through `openedAnyFrame` — evidence that
   * arrives late still counts, which is the whole point of deferring.
   */
  const settleUnreadableVerdict = (frameId: number): void => {
    if (verdictFenceFrameId < 0) return;
    if (frameId <= verdictFenceFrameId) verdictFenceRemaining -= 1;
    if (verdictFenceRemaining > 0) return;
    if (openedAnyFrame || reportedUnreadable) return;
    reportedUnreadable = true;
    notifySubscribers((subscriber) => subscriber.onRoomUnreadable?.());
  };

  const totalPendingBytes = (queues: ChannelQueues): number =>
    queues.scene.pendingBytes + queues.presence.pendingBytes;

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
      // `scene-init` reply and restores convergence. Coalesced per congestion
      // episode: reported once, then re-armed when the scene queue drains.
      if (channel === "scene" && !connection.sceneSyncReported) {
        connection.sceneSyncReported = true;
        notifySubscribers((subscriber) => subscriber.onSceneSyncRequired?.());
      }
      return;
    }
    // Copied because the payload now outlives this callback while it waits its
    // turn, and it is only a view onto the socket's message buffer.
    const payload = Uint8Array.from(dataFrame.payload);
    queue.pendingBytes += queueCost;
    // Counted at admission, not at decryption, so a frame waiting its turn on the
    // *other* channel's chain still holds the verdict back. The id is what makes
    // "was this frame already in flight when the verdict was armed" answerable.
    pendingFrameOpens += 1;
    lastAdmittedFrameId += 1;
    const frameId = lastAdmittedFrameId;
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
        // and converges via scene-init snapshots. The three are indistinguishable
        // at one frame, so only the aggregate can tell them apart:
        // `noteFrameOpenFailed` plus `settleUnreadableVerdict` are what make
        // "every frame failed and none ever succeeded" reportable without
        // changing what happens to any individual frame.
        if (!opened.ok) {
          noteFrameOpenFailed();
          return;
        }
        openedAnyFrame = true;
        if (active !== connection || !connection.session) return;
        const decoded = decodeCollaborationMessage(opened.plaintext, channel);
        // Malformed or oversize payloads are another client's protocol
        // violation; this receiver drops them and converges the same way.
        if (!decoded.ok) return;
        const meta = { byteLength: opened.plaintext.byteLength };
        // A delivered scene message ends the reported episode: the queue had
        // room again, so the next drop is new evidence and reports anew even
        // if the backlog never fully drains.
        if (channel === "scene") connection.sceneSyncReported = false;
        notifySubscribers((subscriber) =>
          subscriber.onMessage?.(decoded.message, meta),
        );
      } catch {
        // A failure inside the open/decode path must not break this channel's
        // delivery order; subscriber throws are already contained per
        // subscriber by `notifySubscribers`.
      } finally {
        queue.pendingBytes -= queueCost;
        // The congestion episode is over once the scene queue fully drains;
        // the next drop is new evidence and reports again.
        if (channel === "scene" && queue.pendingBytes === 0) {
          connection.sceneSyncReported = false;
        }
        pendingFrameOpens -= 1;
        // Every settled frame is a chance for the armed verdict to become
        // reportable — or to be cancelled by a success that landed late.
        settleUnreadableVerdict(frameId);
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
    connect({ roomId, joinToken }) {
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
        outbound: newQueues(),
        inbound: newQueues(),
        sceneSyncReported: false,
      };
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
