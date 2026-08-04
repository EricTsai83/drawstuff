import type {
  ClientId,
  MessageChannel,
  PeerId,
} from "@drawstuff/collaboration/protocol";
import type { RelayPeer } from "@drawstuff/collaboration/relay-protocol";
import type { RoomChannelKey } from "@drawstuff/collaboration/room-auth";

/**
 * Delivery sink one room member registers with the fanout. Implementations
 * must not block: the relay applies its slow-consumer policy inside the sink.
 */
export type FanoutSubscriber = {
  /** A data frame published by another member of the same room. */
  deliverData(
    channel: MessageChannel,
    frame: Uint8Array,
    senderPeerId: PeerId,
  ): void;
  /** Full room membership after a join/leave, including the receiver. */
  deliverPeers(peers: readonly RelayPeer[]): void;
};

type FanoutJoinResult = {
  roomGeneration: number;
  /** Membership at join time, including the joiner. */
  peers: readonly RelayPeer[];
};

/**
 * Room routing boundary of the relay. The relay core only talks to this
 * interface, so the production multi-instance fanout (selected and validated
 * in Plan 19) can replace the process-local implementation without touching
 * connection handling. The in-memory implementation below is correct for a
 * single process only — it must not be mistaken for a horizontally scalable
 * architecture.
 *
 * The fanout is stateless with respect to scene content: it routes frames
 * synchronously and never retains them, so relay memory holds no durable
 * scene or binary payloads.
 *
 * Rooms are addressed by `RoomChannelKey` — room id plus authorization
 * generation — so rotating a room's generation produces a disjoint channel and
 * a member holding an old-generation token cannot reach the new one.
 */
export interface RoomFanout {
  join(member: {
    channel: RoomChannelKey;
    clientId: ClientId;
    peerId: PeerId;
    subscriber: FanoutSubscriber;
  }): FanoutJoinResult;
  leave(channel: RoomChannelKey, peerId: PeerId): void;
  /** Route one data frame to every other member of the room. */
  publish(
    channel: RoomChannelKey,
    senderPeerId: PeerId,
    messageChannel: MessageChannel,
    frame: Uint8Array,
  ): void;
  memberCount(channel: RoomChannelKey): number;
  roomCount(): number;
}

type RoomMember = {
  readonly peerId: PeerId;
  readonly clientId: ClientId;
  readonly subscriber: FanoutSubscriber;
};

type RoomState = {
  readonly generation: number;
  readonly members: Map<PeerId, RoomMember>;
  /** Bumped on every join/leave; lets an in-flight membership broadcast
   *  detect that it became stale mid-iteration. */
  membershipVersion: number;
};

export function createInMemoryRoomFanout(options?: {
  now?: () => number;
}): RoomFanout {
  const now = options?.now ?? Date.now;
  const rooms = new Map<RoomChannelKey, RoomState>();

  /**
   * Room epochs must advance strictly, including across relay restarts and
   * across delete/recreate churn of the same room id. Seeding the counter
   * from the clock keeps it monotonic over restarts without persisting
   * anything; bumping past the last issued value keeps same-millisecond room
   * churn strictly increasing with O(1) state.
   */
  let lastIssuedGeneration = 0;
  const nextGeneration = (): number => {
    lastIssuedGeneration = Math.max(
      lastIssuedGeneration + 1,
      Math.floor(now()),
    );
    return lastIssuedGeneration;
  };

  const peersOf = (room: RoomState): RelayPeer[] =>
    [...room.members.values()].map(({ peerId, clientId }) => ({
      peerId,
      clientId,
    }));

  const broadcastPeers = (room: RoomState, excludePeerId?: PeerId): void => {
    const version = room.membershipVersion;
    const peers = peersOf(room);
    for (const member of room.members.values()) {
      if (member.peerId === excludePeerId) continue;
      // A sink may synchronously close a slow member, re-entering leave()
      // and re-broadcasting a newer snapshot to everyone. Delivering the
      // rest of this now-stale snapshot would overwrite that newer state,
      // so the outdated broadcast aborts instead.
      if (room.membershipVersion !== version) return;
      member.subscriber.deliverPeers(peers);
    }
  };

  return {
    join({ channel, clientId, peerId, subscriber }) {
      let room = rooms.get(channel);
      if (!room) {
        room = {
          generation: nextGeneration(),
          members: new Map(),
          membershipVersion: 0,
        };
        rooms.set(channel, room);
      }
      if (room.members.has(peerId)) {
        throw new Error(`Peer ${peerId} is already a member of ${channel}`);
      }
      room.members.set(peerId, { peerId, clientId, subscriber });
      room.membershipVersion += 1;
      // Existing members learn about the joiner here; the joiner receives the
      // same snapshot in the join result (its `joined` acknowledgment), so it
      // is excluded to avoid a duplicate first notification.
      broadcastPeers(room, peerId);
      return { roomGeneration: room.generation, peers: peersOf(room) };
    },
    leave(channel, peerId) {
      const room = rooms.get(channel);
      if (!room?.members.delete(peerId)) return;
      room.membershipVersion += 1;
      if (room.members.size === 0) {
        // Last member left: release the room immediately so idle room ids
        // hold no relay memory. A later join creates a fresh epoch.
        rooms.delete(channel);
        return;
      }
      broadcastPeers(room);
    },
    publish(channel, senderPeerId, messageChannel, frame) {
      const room = rooms.get(channel);
      if (!room?.members.has(senderPeerId)) return;
      for (const member of room.members.values()) {
        if (member.peerId === senderPeerId) continue;
        member.subscriber.deliverData(messageChannel, frame, senderPeerId);
      }
    },
    memberCount(channel) {
      return rooms.get(channel)?.members.size ?? 0;
    },
    roomCount() {
      return rooms.size;
    },
  };
}
