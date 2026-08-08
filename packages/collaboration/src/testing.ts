import {
  decodeCollaborationMessage,
  encodeCollaborationMessage,
} from "./codec.ts";
import {
  peerIdSchema,
  type CollaborationMessage,
  type PeerId,
  type RoomId,
} from "./messages.ts";
import { roomRoleCanEditScene, type RoomRole } from "./room-auth.ts";
import type {
  CollaborationTransport,
  ConnectionState,
  DisconnectReason,
  RoomPeer,
  SendResult,
  TransportSubscriber,
} from "./transport.ts";

/**
 * Deterministic pseudo-random generator (mulberry32) for fault injection.
 *
 * Fault matrices are only useful if a failure can be replayed, so the fake
 * network never touches `Math.random`: a test picks a seed, and a failing seed is
 * the whole reproduction.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Delivery faults the network injects, each as an independent per-message
 * probability in `[0, 1]`.
 *
 * `delayProbability` deliberately breaks the transport's session-ordering
 * guarantee: a delayed frame is requeued behind messages sent after it, so the
 * receiver sees a scene sequence go backwards. A real relay cannot do that over
 * one socket, which is exactly why it is worth injecting — it proves the inbound
 * gate rejects the stale frame instead of applying it, and that the snapshot
 * repair path converges anyway rather than relying on ordering to be true.
 */
export type FakeNetworkFaults = {
  /** Message is lost outright, including on the session-ordered channel. */
  dropProbability?: number;
  /** Message is delivered twice, as a retransmitting middlebox would. */
  duplicateProbability?: number;
  /** Message is held back to a later flush: added latency and reordering. */
  delayProbability?: number;
  /** Hard bound on how many flushes one message may be held back. */
  maxDelayRounds?: number;
};

export interface FakeCollaborationNetworkOptions {
  /**
   * Upper bound for the shared undelivered-message queue. Sends beyond it
   * fail with a `queue-overflow` error instead of growing memory.
   */
  maxQueuedMessages?: number;
  /** Fault-injection randomness; seed it for reproducible matrices. */
  random?: () => number;
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
   * Installs (or clears, when called with no faults) the delivery fault profile
   * applied by every subsequent `flush`.
   */
  setFaults(faults?: FakeNetworkFaults): void;
  /**
   * Drops one member's connection the way a relay-side failure does. Reports
   * `transient` by default — the reason a network failure or a relay restart
   * carries — so a client's recovery policy sees something worth retrying rather
   * than a local `disconnect()`.
   */
  dropConnection(transport: CollaborationTransport): void;
  /**
   * Changes the reason subsequent `dropConnection` and `restartRoom` calls
   * report, so a test can inject the closes a real relay makes for authorization
   * reasons and not only the transient ones.
   */
  setDisconnectReason(reason: DisconnectReason): void;
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
  session: { roomId: RoomId; peerId: PeerId; generation: number } | undefined;
  closed: boolean;
  /** Why the last session ended; mirrors the real transport's contract. */
  disconnectReason: DisconnectReason;
}

interface RoomMember {
  readonly transport: FakeTransportInternal;
  readonly peerId: PeerId;
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
  /** Flushes this message has already been held back by the delay fault. */
  delayedRounds: number;
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
  const random = options.random ?? Math.random;
  const rooms = new Map<RoomId, RoomState>();
  /** Lets `dropConnection` reach the internals behind a public transport. */
  const internals = new WeakMap<
    CollaborationTransport,
    FakeTransportInternal
  >();
  let queue: QueuedMessage[] = [];
  let nextPeerNumber = 1;
  let faults: FakeNetworkFaults | undefined;
  /** Reason `dropConnection` and `restartRoom` report; see `setDisconnectReason`. */
  let dropReason: DisconnectReason = "transient";

  const rollFault = (probability: number | undefined): boolean =>
    probability !== undefined && probability > 0 && random() < probability;

  const notifyMembership = (room: RoomState): void => {
    for (const member of room.members) {
      const peers: readonly RoomPeer[] = room.members.map(
        ({ peerId, transport }) => ({
          peerId,
          role: transport.role,
        }),
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
      return { status: "disconnected", reason: transport.disconnectReason };
    }
    return {
      status: "connected",
      roomId: transport.session.roomId,
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

  const leaveRoom = (
    transport: FakeTransportInternal,
    reason: DisconnectReason,
  ): void => {
    const session = transport.session;
    if (!session) {
      return;
    }
    transport.session = undefined;
    transport.disconnectReason = reason;
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
      delayedRounds: 0,
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
        disconnectReason: "idle",
      };

      const transport: CollaborationTransport = {
        getConnectionState: () => connectionStateOf(internal),
        connect({ roomId, joinToken }) {
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
            peerId,
            generation: room.generation,
          };
          room.members.push({ transport: internal, peerId });
          notifyConnectionState(internal);
          notifyMembership(room);
        },
        disconnect() {
          leaveRoom(internal, "idle");
        },
        close() {
          if (internal.closed) {
            return;
          }
          // Terminal flag first, so reentrant connects from the callbacks
          // fired below are rejected instead of resurrecting room membership.
          internal.closed = true;
          const wasConnected = internal.session !== undefined;
          leaveRoom(internal, "idle");
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
      internals.set(transport, internal);
      return transport;
    },
    flush(options) {
      const pending = queue;
      queue = [];
      let delivered = 0;

      const deliverOnce = (item: QueuedMessage, room: RoomState): void => {
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
            subscriber.onMessage?.(decoded.message, {
              byteLength: item.bytes.byteLength,
            });
            delivered += 1;
          }
        }
      };

      for (const item of pending) {
        // A sender closed mid-flush purges the rest of its active batch too.
        if (item.sender.closed) {
          continue;
        }
        if (options?.dropPresenceMessages && item.volatile) {
          continue;
        }
        if (rollFault(faults?.dropProbability)) {
          continue;
        }
        // Held back to a later flush, and requeued at the *tail* so messages
        // sent after it arrive first. The bound is what keeps `settle()` from
        // looping: a message cannot be delayed forever.
        if (
          item.delayedRounds < (faults?.maxDelayRounds ?? 0) &&
          rollFault(faults?.delayProbability)
        ) {
          queue.push({ ...item, delayedRounds: item.delayedRounds + 1 });
          continue;
        }
        const room = rooms.get(item.roomId);
        if (!room) {
          continue;
        }
        deliverOnce(item, room);
        if (rollFault(faults?.duplicateProbability)) {
          deliverOnce(item, room);
        }
      }

      return delivered;
    },
    pendingMessageCount: () => queue.length,
    setFaults(nextFaults) {
      faults = nextFaults;
    },
    setDisconnectReason(reason) {
      dropReason = reason;
    },
    dropConnection(transport) {
      const internal = internals.get(transport);
      if (!internal) {
        throw new Error("dropConnection: transport is not from this network");
      }
      leaveRoom(internal, dropReason);
    },
    restartRoom(roomId) {
      const room = rooms.get(roomId);
      if (room) {
        for (const member of [...room.members]) {
          // A restart is not a member leaving: every client sees a failure it
          // should recover from, which is what makes the restart testable
          // against the recovery policy rather than against `disconnect()`.
          leaveRoom(member.transport, dropReason);
        }
      }
      // Purge after every member left: membership callbacks fired during the
      // teardown can still send, and those messages must not survive either.
      queue = queue.filter((item) => item.roomId !== roomId);
    },
  };
}
