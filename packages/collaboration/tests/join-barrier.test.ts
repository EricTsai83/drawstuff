import { describe, expect, it } from "vitest";

import {
  createJoinBarrier,
  DEFAULT_JOIN_BUFFER_MAX_BYTES,
  DEFAULT_JOIN_BUFFER_MAX_MESSAGES,
  electSnapshotResponder,
} from "../src/join-barrier.ts";
import {
  clientIdSchema,
  peerIdSchema,
  type PeerId,
  type SceneMessage,
} from "../src/protocol.ts";
import type { RoomPeer } from "../src/transport.ts";
import { sceneMessage } from "./helpers.ts";

const update = (sequence: number): SceneMessage => sceneMessage({ sequence });

describe("createJoinBarrier", () => {
  it("holds messages and releases them in arrival order", () => {
    const barrier = createJoinBarrier();
    const first = update(1);
    const second = update(2);
    const third = update(3);

    expect(barrier.isHolding()).toBe(true);
    for (const message of [first, second, third]) {
      expect(barrier.hold(message, 100)).toEqual({ held: true });
    }
    expect(barrier.bufferedMessageCount()).toBe(3);
    expect(barrier.bufferedByteLength()).toBe(300);

    expect(barrier.release()).toEqual([first, second, third]);
    expect(barrier.isHolding()).toBe(false);
    expect(barrier.bufferedMessageCount()).toBe(0);
    expect(barrier.needsSceneSync()).toBe(false);
  });

  it("claims the baseline exactly once, so a second responder is ordinary traffic", () => {
    const barrier = createJoinBarrier();
    expect(barrier.hasBaseline()).toBe(false);
    expect(barrier.claimBaseline()).toBe(true);
    expect(barrier.hasBaseline()).toBe(true);
    // Two peers briefly disagreeing about who answers must not restart the join.
    expect(barrier.claimBaseline()).toBe(false);
  });

  it("drops the buffer and owes a full sync when the message cap is hit", () => {
    const barrier = createJoinBarrier({ maxBufferedMessages: 2 });
    expect(barrier.hold(update(1), 10).held).toBe(true);
    expect(barrier.hold(update(2), 10).held).toBe(true);
    expect(barrier.hold(update(3), 10)).toEqual({
      held: false,
      reason: "buffer-overflow",
    });

    // A partial buffer would replay a gap-ridden prefix and still need the
    // repair, so nothing is kept and the repair is recorded instead.
    expect(barrier.bufferedMessageCount()).toBe(0);
    expect(barrier.bufferedByteLength()).toBe(0);
    expect(barrier.needsSceneSync()).toBe(true);
    expect(barrier.release()).toEqual([]);
  });

  it("bounds bytes as well as count, so a few big messages cannot flood it", () => {
    const barrier = createJoinBarrier({ maxBufferedBytes: 1_000 });
    expect(barrier.hold(update(1), 600).held).toBe(true);
    expect(barrier.hold(update(2), 600).held).toBe(false);
    expect(barrier.needsSceneSync()).toBe(true);
  });

  it("keeps the overflow flag once raised, even after later messages fit", () => {
    const barrier = createJoinBarrier({ maxBufferedMessages: 1 });
    barrier.hold(update(1), 1);
    barrier.hold(update(2), 1);
    expect(barrier.needsSceneSync()).toBe(true);
    expect(barrier.hold(update(3), 1).held).toBe(true);
    // The gap the drop created is still there; the repair is still owed.
    expect(barrier.needsSceneSync()).toBe(true);
  });

  it("release is idempotent and hold after release is a programming error", () => {
    const barrier = createJoinBarrier();
    barrier.hold(update(1), 10);
    expect(barrier.release()).toHaveLength(1);
    expect(barrier.release()).toEqual([]);
    expect(() => barrier.hold(update(2), 10)).toThrow(/no longer holding/i);
  });

  it("dispose drops held messages without delivering them", () => {
    const barrier = createJoinBarrier();
    barrier.hold(update(1), 10);
    barrier.dispose();
    expect(barrier.isHolding()).toBe(false);
    expect(barrier.bufferedMessageCount()).toBe(0);
    expect(barrier.bufferedByteLength()).toBe(0);
    expect(barrier.release()).toEqual([]);
  });

  it("rejects nonsensical limits instead of silently unbounding the buffer", () => {
    expect(() => createJoinBarrier({ maxBufferedMessages: 0 })).toThrow(
      /positive integer/i,
    );
    expect(() => createJoinBarrier({ maxBufferedBytes: -1 })).toThrow(
      /positive integer/i,
    );
    expect(DEFAULT_JOIN_BUFFER_MAX_MESSAGES).toBeGreaterThan(0);
    expect(DEFAULT_JOIN_BUFFER_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe("electSnapshotResponder", () => {
  const peer = (name: string, role: RoomPeer["role"] = "editor"): RoomPeer => ({
    peerId: peerIdSchema.parse(name),
    clientId: clientIdSchema.parse(`client-${name}`),
    role,
  });
  const ids = (...names: string[]): ReadonlySet<PeerId> =>
    new Set(names.map((name) => peerIdSchema.parse(name)));

  it("picks the smallest pre-existing peer id, independent of list order", () => {
    const peers = [peer("peer-c"), peer("peer-a"), peer("peer-new")];
    const newPeerIds = ids("peer-new");
    expect(electSnapshotResponder({ peers, newPeerIds })?.peerId).toBe(
      "peer-a",
    );
    expect(
      electSnapshotResponder({ peers: [...peers].reverse(), newPeerIds })
        ?.peerId,
    ).toBe("peer-a");
  });

  it("never asks a newcomer to answer: it has no baseline of its own yet", () => {
    const peers = [peer("peer-a"), peer("peer-b")];
    // Both joined in the same membership change (simultaneous joins).
    expect(
      electSnapshotResponder({ peers, newPeerIds: ids("peer-a", "peer-b") }),
    ).toBeUndefined();
  });

  it("never elects a viewer, whose scene frames the relay would refuse", () => {
    const peers = [peer("peer-a", "viewer"), peer("peer-b"), peer("peer-new")];
    expect(
      electSnapshotResponder({ peers, newPeerIds: ids("peer-new") })?.peerId,
    ).toBe("peer-b");
  });

  it("elects nobody when only viewers could answer, so the joiner falls back", () => {
    const peers = [peer("peer-a", "viewer"), peer("peer-new")];
    expect(
      electSnapshotResponder({ peers, newPeerIds: ids("peer-new") }),
    ).toBeUndefined();
  });

  it("agrees across members that hold the same membership view", () => {
    const peers = [peer("peer-a"), peer("peer-b"), peer("peer-c")];
    const newPeerIds = ids("peer-c");
    // Every existing member computes the same responder from the same notice,
    // which is what keeps one join to one snapshot reply.
    const answers = peers.map(
      () => electSnapshotResponder({ peers, newPeerIds })?.peerId,
    );
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe("peer-a");
  });
});
