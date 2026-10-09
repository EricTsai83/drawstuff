import type {
  CollaborationMessage,
  PeerId,
  PresenceMessage,
  RoomId,
  SceneMessage,
  SnapshotControlMessage,
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
   * The identity proof was refused. A fresh proof may be accepted (short-lived
   * proofs expire), so this is retryable — but only through the app backend,
   * which is also where a genuinely removed member is refused.
   */
  | "unauthorized"
  /** This member's room authorization was revoked while connected. Terminal. */
  | "membership-revoked"
  /** The room was ended by its owner. Terminal. */
  | "room-ended"
  /**
   * This client broke the wire contract (or the server did). Terminal:
   * reconnecting would repeat the same violation.
   */
  | "protocol"
  /**
   * This client and the relay speak different `COLLABORATION_PROTOCOL_VERSION`s:
   * either this tab loaded code before a bump, or the web app deployed a bump
   * before the relay did. Retryable within a bounded deploy-skew window
   * (`./recovery.ts`) — a rollout finishes in minutes — and terminal after
   * it, when the honest instruction is "refresh", not "report a protocol bug".
   */
  | "unsupported-protocol-version";

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
 * `byteLength` is the encoded message size, which is what a bounded receive
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
 * Every connection is authorized: `connect` requires a short-lived identity
 * proof issued by the app backend, and the role the room computed for it
 * arrives back in the connected state. Rooms are protected by sign-in plus
 * the room's access rules, like owned scenes; payloads travel over WSS and are
 * not end-to-end encrypted.
 */
export interface CollaborationTransport {
  getConnectionState(): ConnectionState;
  connect(session: {
    roomId: RoomId;
    /** Short-lived identity proof from the app backend, verified by the room. */
    joinToken: string;
  }): void;
  /** Leave the room but keep the transport reusable for a later connect. */
  disconnect(): void;
  /** Terminal: disconnect, drop subscribers, and refuse further connects. */
  close(): void;
  sendSceneMessage(message: SceneMessage | SnapshotControlMessage): SendResult;
  sendPresenceMessage(message: PresenceMessage): SendResult;
  /** Returns an unsubscribe function. */
  subscribe(subscriber: TransportSubscriber): () => void;
}
