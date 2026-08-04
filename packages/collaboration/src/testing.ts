import {
  decodeCollaborationMessage,
  encodeCollaborationMessage,
} from "./codec.ts";
import {
  peerIdSchema,
  type ClientId,
  type CollaborationMessage,
  type PeerId,
  type RoomId,
} from "./messages.ts";
import { roomRoleCanEditScene, type RoomRole } from "./room-auth.ts";
import type {
  CollaborationTransport,
  ConnectionState,
  RoomPeer,
  SendResult,
  TransportSubscriber,
} from "./transport.ts";

export interface FakeCollaborationNetworkOptions {
  /**
   * Upper bound for the shared undelivered-message queue. Sends beyond it
   * fail with a `queue-overflow` error instead of growing memory.
   */
  maxQueuedMessages?: number;
}

export interface FakeCollaborationNetwork {
  /**
   * The fake network models delivery semantics, not authorization: `connect`
   * still requires a non-empty join token (so a caller cannot skip the
   * authorized path), but the granted role is fixed here instead of being
   * derived from a signed token. Token verification itself is covered by the
   * room-token and relay tests.
   */
  createTransport(options?: { role?: RoomRole }): CollaborationTransport;
  /**
   * Deliver queued messages in FIFO order and return how many were delivered.
   * Messages sent from inside subscriber callbacks queue for the next flush,
   * so tests control interleaving explicitly.
   */
  flush(options?: { dropPresenceMessages?: boolean }): number;
  pendingMessageCount(): number;
  /**
   * Simulate a relay restart: every member is disconnected, in-flight
   * messages for the room are lost, and the next join starts a new room
   * generation.
   */
  restartRoom(roomId: RoomId): void;
}

interface FakeTransportInternal {
  readonly subscribers: Set<TransportSubscriber>;
  readonly role: RoomRole;
  session:
    | { roomId: RoomId; clientId: ClientId; peerId: PeerId; generation: number }
    | undefined;
  closed: boolean;
}

interface RoomMember {
  readonly transport: FakeTransportInternal;
  readonly peerId: PeerId;
  readonly clientId: ClientId;
}

interface RoomState {
  generation: number;
  members: RoomMember[];
}

interface QueuedMessage {
  roomId: RoomId;
  sender: FakeTransportInternal;
  bytes: Uint8Array;
  volatile: boolean;
}

/**
 * Deterministic in-memory implementation of `CollaborationTransport`.
 *
 * Every send goes through the real protocol codec, so schema validation and
 * byte limits behave exactly as they will over a real transport, and every
 * receiver decodes its own copy, so cross-client object mutation cannot leak.
 * Peer ids (`peer-1`, `peer-2`, …) and room generations are assigned from
 * counters, never from clocks or randomness.
 *
 * Deliberately not encrypted. Payloads never leave the process here — there is
 * no socket, no relay, and no third party to keep them from — so sealing them
 * would only make delivery asynchronous and every ordering assertion racy.
 * End-to-end encryption is a property of the wire, and it is enforced where the
 * wire is: `createRelayWebSocketTransport` requires a `RealtimeCryptoCodec`,
 * and the relay integration tests assert that nothing readable is routed.
 */
const DEFAULT_MAX_QUEUED_MESSAGES = 256;

export function createFakeCollaborationNetwork(
  options: FakeCollaborationNetworkOptions = {},
): FakeCollaborationNetwork {
  const maxQueuedMessages =
    options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES;
  if (!Number.isSafeInteger(maxQueuedMessages) || maxQueuedMessages <= 0) {
    throw new Error(
      `maxQueuedMessages must be a positive integer, received ${maxQueuedMessages}`,
    );
  }
  const rooms = new Map<RoomId, RoomState>();
  let queue: QueuedMessage[] = [];
  let nextPeerNumber = 1;

  const notifyMembership = (room: RoomState): void => {
    for (const member of room.members) {
      const peers: readonly RoomPeer[] = room.members.map(
        ({ peerId, clientId }) => ({ peerId, clientId }),
      );
      for (const subscriber of member.transport.subscribers) {
        subscriber.onRoomPeersChange?.(peers);
      }
    }
  };

  const connectionStateOf = (
    transport: FakeTransportInternal,
  ): ConnectionState => {
    if (transport.closed) {
      return { status: "closed" };
    }
    if (!transport.session) {
      return { status: "disconnected" };
    }
    return {
      status: "connected",
      roomId: transport.session.roomId,
      clientId: transport.session.clientId,
      peerId: transport.session.peerId,
      roomGeneration: transport.session.generation,
      role: transport.role,
    };
  };

  const notifyConnectionState = (transport: FakeTransportInternal): void => {
    const state = connectionStateOf(transport);
    for (const subscriber of transport.subscribers) {
      subscriber.onConnectionStateChange?.(state);
    }
  };

  const leaveRoom = (transport: FakeTransportInternal): void => {
    const session = transport.session;
    if (!session) {
      return;
    }
    transport.session = undefined;
    const room = rooms.get(session.roomId);
    if (room) {
      room.members = room.members.filter(
        (member) => member.transport !== transport,
      );
      notifyMembership(room);
    }
    notifyConnectionState(transport);
  };

  const send = (
    transport: FakeTransportInternal,
    message: CollaborationMessage,
  ): SendResult => {
    const session = transport.session;
    if (!session) {
      return { ok: false, error: { code: "not-connected" } };
    }
    if (message.type !== "presence" && !roomRoleCanEditScene(transport.role)) {
      return { ok: false, error: { code: "read-only-role" } };
    }
    if (
      message.roomId !== session.roomId ||
      message.senderPeerId !== session.peerId ||
      message.senderClientId !== session.clientId ||
      message.roomGeneration !== session.generation
    ) {
      return { ok: false, error: { code: "stale-session" } };
    }

    const encoded = encodeCollaborationMessage(message);
    if (!encoded.ok) {
      return encoded;
    }

    if (queue.length >= maxQueuedMessages) {
      return { ok: false, error: { code: "queue-overflow" } };
    }

    queue.push({
      roomId: session.roomId,
      sender: transport,
      bytes: encoded.bytes,
      volatile: message.type === "presence",
    });
    return { ok: true };
  };

  return {
    createTransport(transportOptions = {}) {
      const internal: FakeTransportInternal = {
        subscribers: new Set(),
        role: transportOptions.role ?? "editor",
        session: undefined,
        closed: false,
      };

      return {
        getConnectionState: () => connectionStateOf(internal),
        connect({ roomId, clientId, joinToken }) {
          if (internal.closed) {
            throw new Error("Transport is closed");
          }
          if (internal.session) {
            throw new Error("Transport is already connected");
          }
          if (joinToken.length === 0) {
            throw new Error("A room join token is required to connect");
          }

          let room = rooms.get(roomId);
          if (!room) {
            room = { generation: 0, members: [] };
            rooms.set(roomId, room);
          }
          if (room.members.length === 0) {
            room.generation += 1;
          }

          const peerId = peerIdSchema.parse(`peer-${nextPeerNumber++}`);
          internal.session = {
            roomId,
            clientId,
            peerId,
            generation: room.generation,
          };
          room.members.push({ transport: internal, peerId, clientId });
          notifyConnectionState(internal);
          notifyMembership(room);
        },
        disconnect() {
          leaveRoom(internal);
        },
        close() {
          if (internal.closed) {
            return;
          }
          // Terminal flag first, so reentrant connects from the callbacks
          // fired below are rejected instead of resurrecting room membership.
          internal.closed = true;
          const wasConnected = internal.session !== undefined;
          leaveRoom(internal);
          // Terminal cleanup: unlike disconnect(), which leaves already-sent
          // messages in flight, close() purges this sender's undelivered
          // messages so nothing retains the closed transport. flush() also
          // skips closed senders, covering an in-progress delivery batch.
          queue = queue.filter((item) => item.sender !== internal);
          if (!wasConnected) {
            notifyConnectionState(internal);
          }
          internal.subscribers.clear();
        },
        sendSceneMessage: (message) => send(internal, message),
        sendPresenceMessage: (message) => send(internal, message),
        subscribe(subscriber) {
          internal.subscribers.add(subscriber);
          return () => {
            internal.subscribers.delete(subscriber);
          };
        },
      };
    },
    flush(options) {
      const pending = queue;
      queue = [];
      let delivered = 0;

      for (const item of pending) {
        // A sender closed mid-flush purges the rest of its active batch too.
        if (item.sender.closed) {
          continue;
        }
        if (options?.dropPresenceMessages && item.volatile) {
          continue;
        }
        const room = rooms.get(item.roomId);
        if (!room) {
          continue;
        }
        for (const member of room.members) {
          if (member.transport === item.sender) {
            continue;
          }
          for (const subscriber of member.transport.subscribers) {
            const decoded = decodeCollaborationMessage(
              item.bytes,
              item.volatile ? "presence" : "scene",
            );
            if (!decoded.ok) {
              throw new Error(
                `Fake network delivered an undecodable message: ${decoded.error.code}`,
              );
            }
            subscriber.onMessage?.(decoded.message);
            delivered += 1;
          }
        }
      }

      return delivered;
    },
    pendingMessageCount: () => queue.length,
    restartRoom(roomId) {
      const room = rooms.get(roomId);
      if (room) {
        for (const member of [...room.members]) {
          leaveRoom(member.transport);
        }
      }
      // Purge after every member left: membership callbacks fired during the
      // teardown can still send, and those messages must not survive either.
      queue = queue.filter((item) => item.roomId !== roomId);
    },
  };
}
