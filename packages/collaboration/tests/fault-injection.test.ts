import { describe, expect, it } from "vitest";

import {
  createFakeCollaborationNetwork,
  createSeededRandom,
} from "../src/testing.ts";
import type { CollaborationMessage } from "../src/protocol.ts";
import {
  connectedState,
  element,
  JOIN_TOKEN,
  ROOM_ID,
  sceneFromSession,
} from "./helpers.ts";

/**
 * Fault injection in the deterministic network.
 *
 * These are tests of the injector itself, not of convergence: a fault matrix is
 * only worth running if "the message was dropped" really means dropped and a
 * failing seed really replays. The convergence properties the faults exist to
 * prove live in the session suite (`apps/web/tests/collab-reconnect-*`), which
 * drives real sessions over this network.
 */

const setupPair = (
  options: Parameters<typeof createFakeCollaborationNetwork>[0] = {},
) => {
  const network = createFakeCollaborationNetwork(options);
  const first = network.createTransport();
  const second = network.createTransport();
  first.connect({ roomId: ROOM_ID, joinToken: JOIN_TOKEN });
  second.connect({
    roomId: ROOM_ID,
    joinToken: JOIN_TOKEN,
  });
  const received: CollaborationMessage[] = [];
  second.subscribe({ onMessage: (message) => received.push(message) });
  const send = (sequence: number): void => {
    first.sendSceneMessage(
      sceneFromSession(connectedState(first), {
        sequence,
        elements: [element({ id: `el-${sequence}`, version: sequence })],
      }),
    );
  };
  return { network, first, second, received, send };
};

describe("createSeededRandom", () => {
  it("replays the same stream for the same seed", () => {
    const first = createSeededRandom(7);
    const second = createSeededRandom(7);
    const draws = Array.from({ length: 20 }, () => first());
    expect(Array.from({ length: 20 }, () => second())).toEqual(draws);
    for (const draw of draws) {
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(1);
    }
  });

  it("produces a different stream for a different seed", () => {
    const a = Array.from({ length: 20 }, createSeededRandom(1));
    const b = Array.from({ length: 20 }, createSeededRandom(2));
    expect(a).not.toEqual(b);
  });
});

describe("fake network fault injection", () => {
  it("delivers everything when no faults are installed", () => {
    const { network, received, send } = setupPair();
    for (let sequence = 1; sequence <= 6; sequence += 1) send(sequence);
    network.flush();
    expect(received.map((message) => message.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("drops session-ordered messages, not only volatile ones", () => {
    // Dropping scene traffic is the point: a receiver only notices via a
    // sequence gap, and a drop of the sender's *last* message produces no gap
    // at all. Convergence has to come from repair, not from delivery.
    const { network, received, send } = setupPair({
      random: createSeededRandom(11),
    });
    network.setFaults({ dropProbability: 1 });
    for (let sequence = 1; sequence <= 5; sequence += 1) send(sequence);
    expect(network.flush()).toBe(0);
    expect(received).toEqual([]);
  });

  it("duplicates a delivered message", () => {
    const { network, received, send } = setupPair({
      random: createSeededRandom(11),
    });
    network.setFaults({ duplicateProbability: 1 });
    send(1);
    expect(network.flush()).toBe(2);
    expect(received.map((message) => message.sequence)).toEqual([1, 1]);
  });

  it("holds a message back and delivers it behind later ones", () => {
    // Scripted draws rather than a seed, so the reordering is stated rather than
    // discovered: hold message 1 twice, let message 2 straight through.
    const draws = [0, 0, 0.9];
    let draw = 0;
    const { network, received, send } = setupPair({
      random: () => draws[draw++] ?? 0.9,
    });
    // Deliberately breaks session ordering, which a real relay cannot do over
    // one socket — the point is to prove the receiver's gate survives it.
    network.setFaults({ delayProbability: 0.5, maxDelayRounds: 2 });

    send(1);
    network.flush();
    expect(received).toEqual([]);

    send(2);
    network.flush();
    expect(received.map((message) => message.sequence)).toEqual([2]);

    // Message 1 has now exhausted its hold budget and arrives behind message 2:
    // the receiver sees this sender's sequence go backwards.
    network.flush();
    expect(received.map((message) => message.sequence)).toEqual([2, 1]);
  });

  it("bounds how long a message may be held so a settle loop terminates", () => {
    const { network, received, send } = setupPair({
      random: createSeededRandom(11),
    });
    network.setFaults({ delayProbability: 1, maxDelayRounds: 2 });
    send(1);
    network.flush();
    network.flush();
    expect(received).toEqual([]);
    // Third flush: the bound is reached, so it must be delivered.
    network.flush();
    expect(received.map((message) => message.sequence)).toEqual([1]);
    expect(network.pendingMessageCount()).toBe(0);
  });

  it("replays the exact same fault pattern for the same seed", () => {
    const patternFor = (seed: number): number[] => {
      const { network, received, send } = setupPair({
        random: createSeededRandom(seed),
      });
      network.setFaults({
        dropProbability: 0.3,
        duplicateProbability: 0.2,
        delayProbability: 0.3,
        maxDelayRounds: 2,
      });
      for (let sequence = 1; sequence <= 30; sequence += 1) send(sequence);
      for (let round = 0; round < 5; round += 1) network.flush();
      return received.map((message) => message.sequence);
    };

    const first = patternFor(4242);
    expect(patternFor(4242)).toEqual(first);
    // A saved failing seed is the whole reproduction, so it must actually
    // determine the pattern.
    expect(patternFor(4243)).not.toEqual(first);
    // And the faults must really be firing, or the determinism is vacuous.
    expect(first.length).toBeLessThan(30);
  });

  it("clears the fault profile when called with nothing", () => {
    const { network, received, send } = setupPair({
      random: createSeededRandom(11),
    });
    network.setFaults({ dropProbability: 1 });
    send(1);
    network.flush();
    expect(received).toEqual([]);

    network.setFaults();
    send(2);
    network.flush();
    expect(received.map((message) => message.sequence)).toEqual([2]);
  });

  it("reports a dropped connection as transient, unlike a local disconnect", () => {
    const { network, first, second } = setupPair();

    network.dropConnection(first);
    expect(first.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
    // The rest of the room is unaffected and sees the membership change.
    expect(connectedState(second).roomGeneration).toBe(1);

    second.disconnect();
    expect(second.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "idle",
    });
  });

  it("refuses to drop a connection it did not create", () => {
    const { network } = setupPair();
    const foreign = createFakeCollaborationNetwork().createTransport();
    expect(() => network.dropConnection(foreign)).toThrow(
      /not from this network/,
    );
  });
});
