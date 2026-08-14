import { describe, expect, it, vi } from "vitest";

import {
  peerIdSchema,
  roomIdSchema,
  type MessageChannel,
  type PeerId,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  parseRelayServerControl,
  type RelayPeer,
} from "@drawstuff/collaboration/relay-protocol";
import type * as RelayProtocol from "@drawstuff/collaboration/relay-protocol";

import {
  roomChannelKey,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";

import {
  createInMemoryRoomFanout,
  type FanoutSubscriber,
} from "../src/fanout.ts";

// Wrapped in a spy so the encode-once broadcast contract is assertable: a
// membership broadcast must encode the snapshot once, not once per member.
vi.mock("@drawstuff/collaboration/relay-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof RelayProtocol>();
  return { ...actual, encodeRelayControl: vi.fn(actual.encodeRelayControl) };
});

const CHANNEL_A = roomChannelKey(roomIdSchema.parse("room-a"), 1);
const CHANNEL_B = roomChannelKey(roomIdSchema.parse("room-b"), 1);

let peerCounter = 0;

/** Decodes the pre-encoded `peers` frame a sink receives back into peers. */
const peersOfEncoded = (encodedPeers: string): readonly RelayPeer[] => {
  const parsed = parseRelayServerControl(encodedPeers);
  if (parsed?.control !== "peers") {
    throw new Error("expected an encoded peers frame");
  }
  return parsed.peers;
};

function member(role: RoomRole = "editor") {
  const peerId = peerIdSchema.parse(`peer-${++peerCounter}`);
  const dataFrames: {
    channel: MessageChannel;
    frame: Uint8Array;
    senderPeerId: PeerId;
  }[] = [];
  const peersUpdates: (readonly RelayPeer[])[] = [];
  const subscriber: FanoutSubscriber = {
    deliverData(channel, frame, senderPeerId) {
      dataFrames.push({ channel, frame, senderPeerId });
      // A member that always accepts, so `publish` reports full delivery.
      return true;
    },
    deliverPeers(encodedPeers) {
      peersUpdates.push(peersOfEncoded(encodedPeers));
    },
  };
  return { peerId, role, subscriber, dataFrames, peersUpdates };
}

describe("createInMemoryRoomFanout", () => {
  it("returns membership to the joiner and notifies existing members", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member();
    const b = member();

    const joinA = fanout.join({ channel: CHANNEL_A, ...a });
    expect(joinA.peers).toEqual([{ peerId: a.peerId, role: "editor" }]);
    expect(a.peersUpdates).toHaveLength(0);

    const joinB = fanout.join({ channel: CHANNEL_A, ...b });
    expect(joinB.peers).toHaveLength(2);
    // Only the pre-existing member is notified; the joiner already has the
    // same snapshot in its join result.
    expect(a.peersUpdates).toHaveLength(1);
    expect(a.peersUpdates[0]).toHaveLength(2);
    expect(b.peersUpdates).toHaveLength(0);
  });

  it("routes frames to other members only, within the room", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member();
    const b = member();
    const other = member();
    fanout.join({ channel: CHANNEL_A, ...a });
    fanout.join({ channel: CHANNEL_A, ...b });
    fanout.join({ channel: CHANNEL_B, ...other });

    const frame = new Uint8Array([0x01, 7]);
    fanout.publish(CHANNEL_A, a.peerId, "scene", frame);

    expect(a.dataFrames).toHaveLength(0);
    expect(other.dataFrames).toHaveLength(0);
    expect(b.dataFrames).toEqual([
      { channel: "scene", frame, senderPeerId: a.peerId },
    ]);
  });

  it("ignores publishes from non-members", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member();
    fanout.join({ channel: CHANNEL_A, ...a });

    fanout.publish(
      CHANNEL_A,
      peerIdSchema.parse("peer-ghost"),
      "scene",
      new Uint8Array([1]),
    );
    expect(a.dataFrames).toHaveLength(0);
  });

  it("broadcasts membership on leave and releases empty rooms", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member();
    const b = member();
    fanout.join({ channel: CHANNEL_A, ...a });
    fanout.join({ channel: CHANNEL_A, ...b });

    fanout.leave(CHANNEL_A, b.peerId);
    expect(a.peersUpdates.at(-1)).toEqual([
      { peerId: a.peerId, role: "editor" },
    ]);
    expect(fanout.memberCount(CHANNEL_A)).toBe(1);

    fanout.leave(CHANNEL_A, a.peerId);
    expect(fanout.roomCount()).toBe(0);
    expect(fanout.memberCount(CHANNEL_A)).toBe(0);
  });

  it("issues strictly increasing room generations across room churn", () => {
    let clock = 5_000;
    const fanout = createInMemoryRoomFanout({ now: () => clock });

    const first = fanout.join({ channel: CHANNEL_A, ...member() });
    expect(first.roomGeneration).toBe(5_000);

    // Same-millisecond delete/recreate churn must still advance the epoch.
    fanout.leave(CHANNEL_A, peerIdSchema.parse(`peer-${peerCounter}`));
    const second = fanout.join({ channel: CHANNEL_A, ...member() });
    expect(second.roomGeneration).toBe(5_001);

    // Once the clock moves past the counter, epochs follow the clock again.
    clock = 9_000;
    fanout.leave(CHANNEL_A, peerIdSchema.parse(`peer-${peerCounter}`));
    const third = fanout.join({ channel: CHANNEL_A, ...member() });
    expect(third.roomGeneration).toBe(9_000);
  });

  it("shares one generation among concurrent members of a room", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const joinA = fanout.join({ channel: CHANNEL_A, ...member() });
    const joinB = fanout.join({ channel: CHANNEL_A, ...member() });
    expect(joinB.roomGeneration).toBe(joinA.roomGeneration);
  });

  it("holds no room state after heavy join/leave churn", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    for (let index = 0; index < 500; index += 1) {
      const channel = roomChannelKey(
        roomIdSchema.parse(`room-${index % 50}`),
        1,
      );
      const churnMember = member();
      fanout.join({ channel, ...churnMember });
      fanout.publish(channel, churnMember.peerId, "scene", new Uint8Array([1]));
      fanout.leave(channel, churnMember.peerId);
    }
    expect(fanout.roomCount()).toBe(0);
  });

  it("never delivers a stale membership snapshot after a reentrant leave", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member();
    const c = member();
    // A behaves like a slow consumer: receiving a membership update makes
    // the connection layer close it, which re-enters leave() while the
    // outer broadcast is still iterating.
    let armed = false;
    const reentrantA: FanoutSubscriber = {
      deliverData: a.subscriber.deliverData.bind(a.subscriber),
      deliverPeers(encodedPeers) {
        a.peersUpdates.push(peersOfEncoded(encodedPeers));
        if (armed) {
          armed = false;
          fanout.leave(CHANNEL_A, a.peerId);
        }
      },
    };
    fanout.join({ channel: CHANNEL_A, ...a, subscriber: reentrantA });
    const b = member();
    fanout.join({ channel: CHANNEL_A, ...b });
    fanout.join({ channel: CHANNEL_A, ...c });

    // B leaves: notifying A makes A leave reentrantly. C must end up with
    // the newest snapshot ([C]), never a stale one still containing A.
    armed = true;
    fanout.leave(CHANNEL_A, b.peerId);

    expect(c.peersUpdates.at(-1)).toEqual([
      { peerId: c.peerId, role: "editor" },
    ]);
    expect(fanout.memberCount(CHANNEL_A)).toBe(1);
  });

  it("encodes the membership snapshot once per broadcast, not once per member", () => {
    // Plan 07 L1: `broadcastPeers` used to let every member's sink encode the
    // same snapshot again — a join storm in a full room paid members² encodes
    // inside the synchronous fanout.
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    for (let index = 0; index < 4; index += 1) {
      fanout.join({ channel: CHANNEL_A, ...member() });
    }

    vi.mocked(encodeRelayControl).mockClear();
    const joiner = member();
    fanout.join({ channel: CHANNEL_A, ...joiner });

    // One encode covers the whole broadcast to the four existing members; the
    // joiner gets its snapshot un-encoded in the join result.
    expect(vi.mocked(encodeRelayControl)).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate peer id within a room", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member();
    fanout.join({ channel: CHANNEL_A, ...a });
    expect(() => fanout.join({ channel: CHANNEL_A, ...a })).toThrow(/already/i);
  });

  it("counts a member removed mid-publish as intended but not delivered", () => {
    // The routing-latency gate trusts `intended === delivered` to mean "every
    // member of this room got the frame". A sink that synchronously removes a
    // *later* member — which happens for real when a slow consumer's close
    // re-enters leave() and the membership broadcast then closes a second slow
    // consumer — must not make that comparison come out true for a partial
    // fanout, so recipients are fixed before any of them is delivered to.
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const sender = member();
    const a = member();
    const b = member();
    const evictB: FanoutSubscriber = {
      deliverData(channel, frame, senderPeerId) {
        fanout.leave(CHANNEL_A, b.peerId);
        return a.subscriber.deliverData(channel, frame, senderPeerId);
      },
      deliverPeers: (encodedPeers) => a.subscriber.deliverPeers(encodedPeers),
    };
    // Joined in this order so A is delivered to — and evicts B — before the loop
    // reaches B; members are iterated in insertion order.
    fanout.join({ channel: CHANNEL_A, ...sender });
    fanout.join({ channel: CHANNEL_A, ...a, subscriber: evictB });
    fanout.join({ channel: CHANNEL_A, ...b });

    const result = fanout.publish(
      CHANNEL_A,
      sender.peerId,
      "scene",
      new Uint8Array([0x01]),
    );

    // Both A and B were members when the publish started, so both are intended.
    expect(result.intended).toBe(2);
    // B was gone before its turn, so its sink reports no delivery.
    expect(result.delivered).toBe(1);
    expect(b.dataFrames).toHaveLength(0);
  });
});
