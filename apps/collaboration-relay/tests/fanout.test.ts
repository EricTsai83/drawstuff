import { describe, expect, it } from "vitest";

import {
  clientIdSchema,
  peerIdSchema,
  roomIdSchema,
  type MessageChannel,
  type PeerId,
} from "@drawstuff/collaboration/protocol";
import type { RelayPeer } from "@drawstuff/collaboration/relay-protocol";

import {
  roomChannelKey,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";

import {
  createInMemoryRoomFanout,
  type FanoutSubscriber,
} from "../src/fanout.ts";

const CHANNEL_A = roomChannelKey(roomIdSchema.parse("room-a"), 1);
const CHANNEL_B = roomChannelKey(roomIdSchema.parse("room-b"), 1);

let peerCounter = 0;

function member(clientName: string, role: RoomRole = "editor") {
  const peerId = peerIdSchema.parse(`peer-${++peerCounter}`);
  const clientId = clientIdSchema.parse(clientName);
  const dataFrames: {
    channel: MessageChannel;
    frame: Uint8Array;
    senderPeerId: PeerId;
  }[] = [];
  const peersUpdates: (readonly RelayPeer[])[] = [];
  const subscriber: FanoutSubscriber = {
    deliverData(channel, frame, senderPeerId) {
      dataFrames.push({ channel, frame, senderPeerId });
    },
    deliverPeers(peers) {
      peersUpdates.push(peers);
    },
  };
  return { peerId, clientId, role, subscriber, dataFrames, peersUpdates };
}

describe("createInMemoryRoomFanout", () => {
  it("returns membership to the joiner and notifies existing members", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member("client-a");
    const b = member("client-b");

    const joinA = fanout.join({ channel: CHANNEL_A, ...a });
    expect(joinA.peers).toEqual([
      { peerId: a.peerId, clientId: a.clientId, role: "editor" },
    ]);
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
    const a = member("client-a");
    const b = member("client-b");
    const other = member("client-other");
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
    const a = member("client-a");
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
    const a = member("client-a");
    const b = member("client-b");
    fanout.join({ channel: CHANNEL_A, ...a });
    fanout.join({ channel: CHANNEL_A, ...b });

    fanout.leave(CHANNEL_A, b.peerId);
    expect(a.peersUpdates.at(-1)).toEqual([
      { peerId: a.peerId, clientId: a.clientId, role: "editor" },
    ]);
    expect(fanout.memberCount(CHANNEL_A)).toBe(1);

    fanout.leave(CHANNEL_A, a.peerId);
    expect(fanout.roomCount()).toBe(0);
    expect(fanout.memberCount(CHANNEL_A)).toBe(0);
  });

  it("issues strictly increasing room generations across room churn", () => {
    let clock = 5_000;
    const fanout = createInMemoryRoomFanout({ now: () => clock });

    const first = fanout.join({ channel: CHANNEL_A, ...member("client-a") });
    expect(first.roomGeneration).toBe(5_000);

    // Same-millisecond delete/recreate churn must still advance the epoch.
    fanout.leave(CHANNEL_A, peerIdSchema.parse(`peer-${peerCounter}`));
    const second = fanout.join({ channel: CHANNEL_A, ...member("client-a") });
    expect(second.roomGeneration).toBe(5_001);

    // Once the clock moves past the counter, epochs follow the clock again.
    clock = 9_000;
    fanout.leave(CHANNEL_A, peerIdSchema.parse(`peer-${peerCounter}`));
    const third = fanout.join({ channel: CHANNEL_A, ...member("client-a") });
    expect(third.roomGeneration).toBe(9_000);
  });

  it("shares one generation among concurrent members of a room", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const joinA = fanout.join({ channel: CHANNEL_A, ...member("client-a") });
    const joinB = fanout.join({ channel: CHANNEL_A, ...member("client-b") });
    expect(joinB.roomGeneration).toBe(joinA.roomGeneration);
  });

  it("holds no room state after heavy join/leave churn", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    for (let index = 0; index < 500; index += 1) {
      const channel = roomChannelKey(
        roomIdSchema.parse(`room-${index % 50}`),
        1,
      );
      const churnMember = member(`client-${index}`);
      fanout.join({ channel, ...churnMember });
      fanout.publish(channel, churnMember.peerId, "scene", new Uint8Array([1]));
      fanout.leave(channel, churnMember.peerId);
    }
    expect(fanout.roomCount()).toBe(0);
  });

  it("never delivers a stale membership snapshot after a reentrant leave", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member("client-a");
    const c = member("client-c");
    // A behaves like a slow consumer: receiving a membership update makes
    // the connection layer close it, which re-enters leave() while the
    // outer broadcast is still iterating.
    let armed = false;
    const reentrantA: FanoutSubscriber = {
      deliverData: a.subscriber.deliverData.bind(a.subscriber),
      deliverPeers(peers) {
        a.peersUpdates.push(peers);
        if (armed) {
          armed = false;
          fanout.leave(CHANNEL_A, a.peerId);
        }
      },
    };
    fanout.join({ channel: CHANNEL_A, ...a, subscriber: reentrantA });
    const b = member("client-b");
    fanout.join({ channel: CHANNEL_A, ...b });
    fanout.join({ channel: CHANNEL_A, ...c });

    // B leaves: notifying A makes A leave reentrantly. C must end up with
    // the newest snapshot ([C]), never a stale one still containing A.
    armed = true;
    fanout.leave(CHANNEL_A, b.peerId);

    expect(c.peersUpdates.at(-1)).toEqual([
      { peerId: c.peerId, clientId: c.clientId, role: "editor" },
    ]);
    expect(fanout.memberCount(CHANNEL_A)).toBe(1);
  });

  it("rejects a duplicate peer id within a room", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = member("client-a");
    fanout.join({ channel: CHANNEL_A, ...a });
    expect(() => fanout.join({ channel: CHANNEL_A, ...a })).toThrow(/already/i);
  });
});
