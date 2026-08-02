import type {
  ClientId,
  CollaborationMessage,
  PeerId,
  PresenceMessage,
  RoomId,
  SceneMessage,
} from "./messages.ts";
import type { CollaborationProtocolError } from "./codec.ts";

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
    }
  | { status: "closed" };

export type RoomPeer = {
  readonly peerId: PeerId;
  readonly clientId: ClientId;
};

export interface TransportSubscriber {
  onConnectionStateChange?(state: ConnectionState): void;
  /** Decoded, protocol-validated inbound message from another room peer. */
  onMessage?(message: CollaborationMessage): void;
  /** Current room membership including this transport's own peer. */
  onRoomPeersChange?(peers: readonly RoomPeer[]): void;
}

export type SendError =
  | { code: "not-connected" }
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
 */
export interface CollaborationTransport {
  getConnectionState(): ConnectionState;
  connect(session: { roomId: RoomId; clientId: ClientId }): void;
  /** Leave the room but keep the transport reusable for a later connect. */
  disconnect(): void;
  /** Terminal: disconnect, drop subscribers, and refuse further connects. */
  close(): void;
  sendSceneMessage(message: SceneMessage): SendResult;
  sendPresenceMessage(message: PresenceMessage): SendResult;
  /** Returns an unsubscribe function. */
  subscribe(subscriber: TransportSubscriber): () => void;
}
