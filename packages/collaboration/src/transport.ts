import type {
  ClientId,
  CollaborationMessage,
  PeerId,
  PresenceMessage,
  RoomId,
  SceneMessage,
} from "./messages.ts";
import type { CollaborationProtocolError } from "./codec.ts";
import type { RoomRole } from "./room-auth.ts";

export type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting"; roomId: RoomId }
  | {
      status: "connected";
      roomId: RoomId;
      clientId: ClientId;
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
  readonly clientId: ClientId;
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
    clientId: ClientId;
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
