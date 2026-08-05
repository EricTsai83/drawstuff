import { describe, expect, it } from "vitest";

import {
  MAX_SCENE_MESSAGE_BYTES,
  type CollaborationMessage,
} from "../src/protocol.ts";
import { createFakeCollaborationNetwork } from "../src/testing.ts";
import type {
  CollaborationTransport,
  ConnectionState,
  RoomPeer,
} from "../src/transport.ts";
import {
  asMessage,
  CLIENT_A,
  CLIENT_B,
  connectedState,
  element,
  JOIN_TOKEN,
  presenceFromSession,
  ROOM_ID,
  sceneFromSession,
  sceneMessage,
} from "./helpers.ts";

const setupPair = () => {
  const network = createFakeCollaborationNetwork();
  const first = network.createTransport();
  const second = network.createTransport();
  first.connect({ roomId: ROOM_ID, clientId: CLIENT_A, joinToken: JOIN_TOKEN });
  second.connect({
    roomId: ROOM_ID,
    clientId: CLIENT_B,
    joinToken: JOIN_TOKEN,
  });
  return { network, first, second };
};

const collectMessages = (transport: CollaborationTransport) => {
  const messages: CollaborationMessage[] = [];
  transport.subscribe({ onMessage: (message) => messages.push(message) });
  return messages;
};

describe("fake collaboration network", () => {
  it("assigns distinct peer ids and a shared room generation on join", () => {
    const { first, second } = setupPair();

    const firstState = connectedState(first);
    const secondState = connectedState(second);

    expect(firstState.roomGeneration).toBe(1);
    expect(secondState.roomGeneration).toBe(1);
    expect(firstState.peerId).not.toBe(secondState.peerId);
    expect(firstState.clientId).toBe(CLIENT_A);
  });

  it("reports room membership to every member as peers join and leave", () => {
    const network = createFakeCollaborationNetwork();
    const first = network.createTransport();
    const rosters: (readonly RoomPeer[])[] = [];
    first.subscribe({ onRoomPeersChange: (peers) => rosters.push(peers) });

    first.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    const second = network.createTransport();
    second.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      joinToken: JOIN_TOKEN,
    });
    second.disconnect();

    expect(rosters.map((peers) => peers.map((peer) => peer.clientId))).toEqual([
      [CLIENT_A],
      [CLIENT_A, CLIENT_B],
      [CLIENT_A],
    ]);
  });

  it("delivers queued messages to other room members but never echoes", () => {
    const { network, first, second } = setupPair();
    const firstInbox = collectMessages(first);
    const secondInbox = collectMessages(second);

    const message = sceneFromSession(connectedState(first), { sequence: 1 });
    expect(first.sendSceneMessage(message)).toEqual({ ok: true });
    expect(network.pendingMessageCount()).toBe(1);
    expect(secondInbox).toEqual([]);

    expect(network.flush()).toBe(1);
    expect(secondInbox).toEqual([message]);
    expect(firstInbox).toEqual([]);
    expect(network.pendingMessageCount()).toBe(0);
  });

  it("gives each receiver an isolated copy of the message", () => {
    const network = createFakeCollaborationNetwork();
    const sender = network.createTransport();
    const receivers = [network.createTransport(), network.createTransport()];
    sender.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    const inboxes = receivers.map((receiver) => {
      receiver.connect({
        roomId: ROOM_ID,
        clientId: CLIENT_B,
        joinToken: JOIN_TOKEN,
      });
      return collectMessages(receiver);
    });

    sender.sendSceneMessage(
      sceneFromSession(connectedState(sender), {
        sequence: 1,
        elements: [element({ label: "original" })],
      }),
    );
    network.flush();

    const [firstCopy] = inboxes[0] ?? [];
    const [secondCopy] = inboxes[1] ?? [];
    if (
      firstCopy?.type !== "scene-update" ||
      secondCopy?.type !== "scene-update"
    ) {
      throw new Error("Expected scene updates in both inboxes");
    }
    Object.assign(firstCopy.payload.elements[0] ?? {}, { label: "mutated" });
    expect(secondCopy.payload.elements[0]?.label).toBe("original");
  });

  it("can drop volatile presence messages without touching scene delivery", () => {
    const { network, first, second } = setupPair();
    const inbox = collectMessages(second);
    const state = connectedState(first);

    first.sendPresenceMessage(presenceFromSession(state, { sequence: 1 }));
    first.sendSceneMessage(sceneFromSession(state, { sequence: 1 }));

    expect(network.flush({ dropPresenceMessages: true })).toBe(1);
    expect(inbox.map((message) => message.type)).toEqual(["scene-update"]);
  });

  it("refuses sends while not connected", () => {
    const network = createFakeCollaborationNetwork();
    const transport = network.createTransport();

    expect(transport.sendSceneMessage(sceneMessage({ sequence: 1 }))).toEqual({
      ok: false,
      error: { code: "not-connected" },
    });
  });

  it("refuses envelopes from a previous session after reconnecting", () => {
    const { first } = setupPair();
    const staleMessage = sceneFromSession(connectedState(first), {
      sequence: 1,
    });

    first.disconnect();
    expect(first.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "idle",
    });
    first.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });

    expect(first.sendSceneMessage(staleMessage)).toEqual({
      ok: false,
      error: { code: "stale-session" },
    });
  });

  it("surfaces protocol validation and byte limits on send", () => {
    const { first } = setupPair();
    const state = connectedState(first);

    const invalid = {
      ...sceneFromSession(state, { sequence: 1 }),
      payload: { elements: [{ id: "el-1" }] },
    };
    expect(first.sendSceneMessage(asMessage(invalid))).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });

    const oversize = sceneFromSession(state, {
      sequence: 1,
      elements: [element({ blob: "x".repeat(MAX_SCENE_MESSAGE_BYTES) })],
    });
    expect(first.sendSceneMessage(oversize)).toMatchObject({
      ok: false,
      error: { code: "oversize-payload" },
    });
  });

  it("bounds the undelivered queue and reports overflow explicitly", () => {
    const network = createFakeCollaborationNetwork({ maxQueuedMessages: 2 });
    const first = network.createTransport();
    const second = network.createTransport();
    first.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    second.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      joinToken: JOIN_TOKEN,
    });
    const state = connectedState(first);

    expect(
      first.sendSceneMessage(sceneFromSession(state, { sequence: 1 })),
    ).toEqual({ ok: true });
    expect(
      first.sendSceneMessage(sceneFromSession(state, { sequence: 2 })),
    ).toEqual({ ok: true });
    expect(
      first.sendSceneMessage(sceneFromSession(state, { sequence: 3 })),
    ).toEqual({ ok: false, error: { code: "queue-overflow" } });
    expect(network.pendingMessageCount()).toBe(2);

    network.flush();
    expect(
      first.sendSceneMessage(sceneFromSession(state, { sequence: 3 })),
    ).toEqual({ ok: true });
  });

  it("rejects queue bounds that would recreate an unbounded queue", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() =>
        createFakeCollaborationNetwork({ maxQueuedMessages: invalid }),
      ).toThrow(/positive integer/);
    }
  });

  it("purges a transport's undelivered messages on close", () => {
    const { network, first, second } = setupPair();
    const inbox = collectMessages(second);
    first.sendSceneMessage(
      sceneFromSession(connectedState(first), { sequence: 1 }),
    );
    expect(network.pendingMessageCount()).toBe(1);

    first.close();

    expect(network.pendingMessageCount()).toBe(0);
    expect(network.flush()).toBe(0);
    expect(inbox).toEqual([]);
  });

  it("starts a new room generation once the room has fully emptied", () => {
    const { network, first, second } = setupPair();

    first.disconnect();
    second.disconnect();
    const third = network.createTransport();
    third.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });

    expect(connectedState(third).roomGeneration).toBe(2);
  });

  it("drops in-flight messages and disconnects members on room restart", () => {
    const { network, first, second } = setupPair();
    first.sendSceneMessage(
      sceneFromSession(connectedState(first), { sequence: 1 }),
    );

    network.restartRoom(ROOM_ID);

    expect(network.pendingMessageCount()).toBe(0);
    // A restart is a failure every member should recover from, not a leave.
    expect(first.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
    expect(second.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });

    first.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    expect(connectedState(first).roomGeneration).toBe(2);
  });

  it("skips the rest of a sender's batch when it closes mid-flush", () => {
    const { network, first, second } = setupPair();
    const inbox = collectMessages(second);
    const state = connectedState(first);
    second.subscribe({ onMessage: () => first.close() });

    first.sendSceneMessage(sceneFromSession(state, { sequence: 1 }));
    first.sendSceneMessage(sceneFromSession(state, { sequence: 2 }));

    // Message 1 reaches both of second's subscribers (the inbox and the
    // closing one); message 2 is skipped because its sender closed.
    expect(network.flush()).toBe(2);
    expect(inbox.map((message) => message.sequence)).toEqual([1]);
  });

  it("purges messages sent from teardown callbacks during room restart", () => {
    const { network, first, second } = setupPair();
    let restartSends = 0;
    second.subscribe({
      onRoomPeersChange: () => {
        const state = second.getConnectionState();
        if (restartSends === 0 && state.status === "connected") {
          restartSends += 1;
          expect(
            second.sendSceneMessage(sceneFromSession(state, { sequence: 1 })),
          ).toEqual({ ok: true });
        }
      },
    });

    network.restartRoom(ROOM_ID);

    expect(restartSends).toBe(1);
    expect(network.pendingMessageCount()).toBe(0);
    expect(first.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
  });

  it("is terminally closed before close-time callbacks fire", () => {
    const network = createFakeCollaborationNetwork();
    const first = network.createTransport();
    const second = network.createTransport();
    first.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    second.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      joinToken: JOIN_TOKEN,
    });
    const states: ConnectionState["status"][] = [];
    let reconnectError: unknown;
    first.subscribe({
      onConnectionStateChange: (state) => {
        states.push(state.status);
        if (state.status === "closed") {
          try {
            first.connect({
              roomId: ROOM_ID,
              clientId: CLIENT_A,
              joinToken: JOIN_TOKEN,
            });
          } catch (error) {
            reconnectError = error;
          }
        }
      },
    });
    const rosters: (readonly RoomPeer[])[] = [];
    second.subscribe({ onRoomPeersChange: (peers) => rosters.push(peers) });

    first.close();

    expect(states).toEqual(["closed"]);
    expect(reconnectError).toBeInstanceOf(Error);
    expect(rosters.at(-1)?.map((peer) => peer.clientId)).toEqual([CLIENT_B]);
  });

  it("queues messages sent from subscriber callbacks for the next flush", () => {
    const { network, first, second } = setupPair();
    const firstInbox = collectMessages(first);
    let replied = false;
    second.subscribe({
      onMessage: () => {
        if (!replied) {
          replied = true;
          second.sendSceneMessage(
            sceneFromSession(connectedState(second), { sequence: 1 }),
          );
        }
      },
    });

    first.sendSceneMessage(
      sceneFromSession(connectedState(first), { sequence: 1 }),
    );

    expect(network.flush()).toBe(1);
    expect(firstInbox).toEqual([]);
    expect(network.pendingMessageCount()).toBe(1);
    expect(network.flush()).toBe(1);
    expect(firstInbox.map((message) => message.type)).toEqual(["scene-update"]);
  });

  it("emits connection state changes and honours unsubscribe and close", () => {
    const network = createFakeCollaborationNetwork();
    const transport = network.createTransport();
    const states: ConnectionState["status"][] = [];
    const unsubscribe = transport.subscribe({
      onConnectionStateChange: (state) => states.push(state.status),
    });

    transport.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    transport.disconnect();
    transport.close();

    expect(states).toEqual(["connected", "disconnected", "closed"]);
    expect(() =>
      transport.connect({
        roomId: ROOM_ID,
        clientId: CLIENT_A,
        joinToken: JOIN_TOKEN,
      }),
    ).toThrow(/closed/);
    unsubscribe();

    const late = network.createTransport();
    const lateStates: string[] = [];
    late.subscribe({
      onConnectionStateChange: (state) => lateStates.push(state.status),
    })();
    late.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    expect(lateStates).toEqual([]);
  });
});
