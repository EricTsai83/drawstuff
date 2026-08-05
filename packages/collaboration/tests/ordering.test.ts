import { describe, expect, it } from "vitest";

import { createInboundMessageGate, roomIdSchema } from "../src/protocol.ts";
import {
  PEER_A,
  PEER_B,
  presenceMessage,
  ROOM_ID,
  sceneMessage,
} from "./helpers.ts";

const createGate = () =>
  createInboundMessageGate({ roomId: ROOM_ID, roomGeneration: 1 });

describe("inbound message gate", () => {
  it("delivers in-order scene updates without requesting a sync", () => {
    const gate = createGate();

    for (const sequence of [1, 2, 3]) {
      expect(gate.accept(sceneMessage({ sequence }))).toEqual({
        action: "deliver",
        sceneSyncRequired: false,
      });
    }
  });

  it("rejects duplicate and stale scene sequences", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 3 }));

    expect(gate.accept(sceneMessage({ sequence: 3 }))).toEqual({
      action: "reject",
      reason: "duplicate-message",
    });
    expect(gate.accept(sceneMessage({ sequence: 2 }))).toEqual({
      action: "reject",
      reason: "stale-sequence",
    });
  });

  it("delivers scene updates across a gap but demands a full sync", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 1 }));

    expect(gate.accept(sceneMessage({ sequence: 4 }))).toEqual({
      action: "deliver",
      sceneSyncRequired: true,
    });
  });

  it("flags a gap when the first observed message skipped earlier updates", () => {
    const gate = createGate();

    expect(gate.accept(sceneMessage({ sequence: 5 }))).toEqual({
      action: "deliver",
      sceneSyncRequired: true,
    });
  });

  it("treats a scene snapshot as healing any gap", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 1 }));

    expect(
      gate.accept(sceneMessage({ type: "scene-init", sequence: 9 })),
    ).toEqual({ action: "deliver", sceneSyncRequired: false });
    expect(gate.accept(sceneMessage({ sequence: 10 }))).toEqual({
      action: "deliver",
      sceneSyncRequired: false,
    });
  });

  it("applies latest-wins to presence: stale drops, gaps are fine", () => {
    const gate = createGate();

    expect(gate.accept(presenceMessage({ sequence: 2 }))).toEqual({
      action: "deliver",
      sceneSyncRequired: false,
    });
    expect(gate.accept(presenceMessage({ sequence: 9 }))).toEqual({
      action: "deliver",
      sceneSyncRequired: false,
    });
    expect(gate.accept(presenceMessage({ sequence: 9 }))).toEqual({
      action: "reject",
      reason: "duplicate-message",
    });
    expect(gate.accept(presenceMessage({ sequence: 5 }))).toEqual({
      action: "reject",
      reason: "stale-sequence",
    });
  });

  it("tracks scene and presence sequence counters independently", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 1 }));
    gate.accept(sceneMessage({ sequence: 2 }));

    expect(gate.accept(presenceMessage({ sequence: 1 }))).toEqual({
      action: "deliver",
      sceneSyncRequired: false,
    });
  });

  it("tracks sequences per sender peer", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 1, senderPeerId: PEER_A }));

    expect(
      gate.accept(sceneMessage({ sequence: 1, senderPeerId: PEER_B })),
    ).toEqual({ action: "deliver", sceneSyncRequired: false });
  });

  it("rejects messages for another room", () => {
    const gate = createGate();

    expect(
      gate.accept(
        sceneMessage({ sequence: 1, roomId: roomIdSchema.parse("room-other") }),
      ),
    ).toEqual({ action: "reject", reason: "wrong-room" });
  });

  it("rejects messages from a different room generation", () => {
    const gate = createGate();

    for (const roomGeneration of [2, 3]) {
      expect(
        gate.accept(sceneMessage({ sequence: 1, roomGeneration })),
      ).toEqual({
        action: "reject",
        reason: "wrong-generation",
        receivedGeneration: roomGeneration,
      });
    }
  });

  it("resets per-peer state when the generation advances", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 5 }));

    gate.advanceGeneration(2);

    expect(gate.accept(sceneMessage({ sequence: 5 }))).toEqual({
      action: "reject",
      reason: "wrong-generation",
      receivedGeneration: 1,
    });
    expect(
      gate.accept(sceneMessage({ sequence: 1, roomGeneration: 2 })),
    ).toEqual({ action: "deliver", sceneSyncRequired: false });
  });

  it("refuses to move the generation backwards or sideways", () => {
    const gate = createGate();

    expect(() => gate.advanceGeneration(1)).toThrow(/must advance/);
    expect(() => gate.advanceGeneration(0)).toThrow(/must advance/);
  });

  it("keeps rejecting late duplicates from departed sessions", () => {
    const gate = createGate();
    gate.accept(sceneMessage({ sequence: 8, senderPeerId: PEER_A }));

    // PEER_A leaves the room; its in-flight messages may still arrive. The
    // gate retains the session counter until the generation advances, so the
    // stragglers are still deduplicated instead of being accepted as new.
    expect(
      gate.accept(sceneMessage({ sequence: 8, senderPeerId: PEER_A })),
    ).toEqual({ action: "reject", reason: "duplicate-message" });
    expect(
      gate.accept(sceneMessage({ sequence: 2, senderPeerId: PEER_A })),
    ).toEqual({ action: "reject", reason: "stale-sequence" });
  });
});
