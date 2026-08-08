import type {
  CollaborationMessage,
  PeerId,
  PresenceMessage,
  RoomId,
  SceneMessage,
} from "./messages.ts";
import type { CollaborationProtocolError } from "./codec.ts";
import type { RoomRole } from "./room-auth.ts";

/**
 * Why a transport is not connected.
 *
 * Recovery is a decision, not a reflex, and this is what it is decided from: a
 * dropped socket and a revoked membership both end a session, but retrying the
 * first is correct and retrying the second is a loop that hides the revocation
 * from the user. The transport therefore reports *why* it is down, and the
 * recovery policy (`./recovery.ts`) maps that to retry, re-authorize, or stop.
 *
 * Deliberately coarse. A client can act on "try again", "get a new token" and
 * "this is over"; the relay's specific close code adds nothing beyond that and
 * would push transport-specific numbers into every caller.
 */
export type DisconnectReason =
  /** No connection has been attempted, or the caller ended it. Never retried. */
  | "idle"
  /**
   * Socket failure, relay restart, capacity, join timeout, or a slow-consumer
   * disconnect. Retryable with backoff; the session heals via snapshot exchange.
   */
  | "transient"
  /**
   * The join token was refused. A fresh token may be accepted (short-lived
   * tokens expire), so this is retryable — but only through the app backend,
   * which is also where a genuinely removed member is refused.
   */
  | "unauthorized"
  /** This member's room authorization was revoked while connected. Terminal. */
  | "membership-revoked"
  /** The room generation was ended or rotated by its owner. Terminal. */
  | "room-ended"
  /**
   * This client broke the wire contract (or the server did). Terminal:
   * reconnecting would repeat the same violation.
   */
  | "protocol";

export type ConnectionState =
  | { status: "disconnected"; reason: DisconnectReason }
  | { status: "connecting"; roomId: RoomId }
  | {
      status: "connected";
      roomId: RoomId;
      /** Session identity assigned by the transport; new on every connect. */
      peerId: PeerId;
      /** Room epoch assigned at join time; stamped on every outbound message. */
      roomGeneration: number;
      /**
       * Role the server granted this connection. Authoritative enforcement is
       * server-side; callers mirror it to keep read-only state visible in the
       * UI and to avoid sending frames that would be refused.
       */
      role: RoomRole;
    }
  | { status: "closed" };

export type RoomPeer = {
  readonly peerId: PeerId;
  /** Role the server granted this peer's connection; see `ConnectionState`. */
  readonly role: RoomRole;
};

/**
 * What a receiver can know about an inbound message without inspecting it.
 * `byteLength` is the decoded plaintext size, which is what a bounded receive
 * buffer has to charge: the message object's own retained size is proportional
 * to it, and a count-only bound would let a few maximum-size scene messages hold
 * hundreds of megabytes.
 */
export type InboundMessageMeta = {
  readonly byteLength: number;
};

export interface TransportSubscriber {
  onConnectionStateChange?(state: ConnectionState): void;
  /** Decoded, protocol-validated inbound message from another room peer. */
  onMessage?(message: CollaborationMessage, meta: InboundMessageMeta): void;
  /** Current room membership including this transport's own peer. */
  onRoomPeersChange?(peers: readonly RoomPeer[]): void;
  /**
   * The transport dropped inbound scene traffic before it could be delivered
   * (for example because its bounded inbound queue was full), so the receiver
   * may now be behind without ever observing a sequence gap.
   *
   * This exists because a silent scene drop is not self-healing: gap detection
   * only fires when a *later* message arrives, and if the lost frame was the
   * sender's last edit, nothing else would trigger a repair. Implementations
   * should re-broadcast their own `scene-init` snapshot, which draws the peer's
   * snapshot reply and restores convergence. Presence loss never reports here —
   * it is volatile by design.
   */
  onSceneSyncRequired?(): void;
  /**
   * Realtime frames reached this transport and *none* of them could ever be
   * opened, so the evidence says the key cannot open this room rather than that
   * one frame was bad.
   *
   * This exists because the per-frame policy above it is deliberately silent: a
   * wrong key, tampered ciphertext and a replayed nonce are indistinguishable at
   * one frame, and dropping the frame is the right answer for the latter two. But
   * silence per frame becomes silence per *session* when every frame fails, and
   * the user then sees a connected, permanently blank canvas with no message —
   * which until now was only caught by reading the durable snapshot, an oracle a
   * room without a stored snapshot does not have.
   *
   * Reported at most once per transport, and never after any frame has opened: a
   * single successful open proves the key is right, which makes every later
   * failure corruption or replay rather than a key mismatch. A session that
   * receives no frames at all reports nothing — "nobody is drawing" is not
   * evidence of anything.
   */
  onRoomUnreadable?(): void;
}

export type SendError =
  | { code: "not-connected" }
  | {
      /** The connection's role may not mutate the scene (viewer). */
      code: "read-only-role";
    }
  | {
      /** Message envelope does not match the current session identity. */
      code: "stale-session";
    }
  | {
      /**
       * The transport's bounded outbound queue is full. Senders must back
       * off; queues never grow without limit.
       */
      code: "queue-overflow";
    }
  | {
      /**
       * The session's end-to-end nonce budget is spent. Sending again would
       * require reusing a nonce under the same derived key, so the transport
       * refuses instead: the session must reconnect (fresh nonce prefix) or
       * the room generation must be rotated (fresh derived key).
       */
      code: "crypto-exhausted";
    }
  | CollaborationProtocolError;

export type SendResult = { ok: true } | { ok: false; error: SendError };

/**
 * Transport-neutral delivery contract between collaboration peers.
 *
 * Delivery guarantees are deliberately weak and explicit:
 *
 * - Scene messages are session-ordered: while a session stays connected they
 *   arrive in send order, but nothing is replayed across disconnects. Gaps
 *   after a reconnect are repaired by exchanging `scene-init` snapshots and
 *   reconciling; the transport never claims exactly-once delivery.
 * - Presence messages are volatile: they may be dropped at any time and are
 *   never required for scene convergence.
 *
 * Implementations must validate and size-limit every message via the protocol
 * codec, and must release all listeners, timers, and queues on `close()`.
 *
 * Every connection is authorized: `connect` requires a short-lived room join
 * token issued by the app backend, and the granted role arrives back in the
 * connected state.
 *
 * Authorization is not confidentiality. Implementations that carry messages
 * over a shared server must seal every payload end-to-end before it leaves the
 * client (`./realtime-crypto.ts`), so the server routes ciphertext it cannot
 * read; the join token deliberately carries no key material.
 */
export interface CollaborationTransport {
  getConnectionState(): ConnectionState;
  connect(session: {
    roomId: RoomId;
    /** Short-lived join token from the app backend, verified by the relay. */
    joinToken: string;
  }): void;
  /** Leave the room but keep the transport reusable for a later connect. */
  disconnect(): void;
  /** Terminal: disconnect, drop subscribers, and refuse further connects. */
  close(): void;
  sendSceneMessage(message: SceneMessage): SendResult;
  sendPresenceMessage(message: PresenceMessage): SendResult;
  /** Returns an unsubscribe function. */
  subscribe(subscriber: TransportSubscriber): () => void;
}
