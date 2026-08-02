import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientIdSchema,
  roomIdSchema,
  type CollaborationMessage,
  type PresenceMessage,
  type SceneMessage,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import type {
  CollaborationTransport,
  ConnectionState,
  RoomPeer,
} from "@drawstuff/collaboration/transport";

import {
  createBroadcastChannelTransport,
  type BroadcastChannelLike,
} from "@/lib/collab/broadcast-channel-transport";

const ROOM_ID = roomIdSchema.parse("room-bc");
const CLIENT_A = clientIdSchema.parse("client-a");
const CLIENT_B = clientIdSchema.parse("client-b");

/** Deterministic in-memory `BroadcastChannel` hub: same-name channels get
 *  every message except their own, delivered synchronously via a clone. */
function createChannelHub() {
  type HubChannel = BroadcastChannelLike & { readonly name: string };
  const channelsByName = new Map<string, Set<HubChannel>>();

  const create = (name: string): HubChannel => {
    let closed = false;
    const channel: HubChannel = {
      name,
      onmessage: null,
      postMessage(message: unknown) {
        if (closed) throw new Error("Channel is closed");
        for (const peer of channelsByName.get(name) ?? []) {
          if (peer === channel) continue;
          peer.onmessage?.({ data: structuredClone(message) } as MessageEvent);
        }
      },
      close() {
        closed = true;
        channelsByName.get(name)?.delete(channel);
      },
    };
    let named = channelsByName.get(name);
    if (!named) {
      named = new Set();
      channelsByName.set(name, named);
    }
    named.add(channel);
    return channel;
  };

  return {
    create,
    openChannelCount(name: string): number {
      return channelsByName.get(name)?.size ?? 0;
    },
  };
}

type TransportProbe = {
  transport: CollaborationTransport;
  states: ConnectionState[];
  peersHistory: (readonly RoomPeer[])[];
  messages: CollaborationMessage[];
  connectedState(): Extract<ConnectionState, { status: "connected" }>;
};

function createProbe(
  hub: ReturnType<typeof createChannelHub>,
): TransportProbe {
  const transport = createBroadcastChannelTransport({
    createChannel: hub.create,
  });
  const states: ConnectionState[] = [];
  const peersHistory: (readonly RoomPeer[])[] = [];
  const messages: CollaborationMessage[] = [];
  transport.subscribe({
    onConnectionStateChange: (state) => states.push(state),
    onRoomPeersChange: (peers) => peersHistory.push(peers),
    onMessage: (message) => messages.push(message),
  });
  return {
    transport,
    states,
    peersHistory,
    messages,
    connectedState() {
      const state = transport.getConnectionState();
      if (state.status !== "connected") {
        throw new Error(`Expected connected transport, got "${state.status}"`);
      }
      return state;
    },
  };
}

function sceneMessageFrom(
  state: Extract<ConnectionState, { status: "connected" }>,
  input: {
    sequence: number;
    type?: SceneMessage["type"];
    elements?: SyncedElement[];
  },
): SceneMessage {
  return {
    protocolVersion: 1,
    messageId: `m-${state.peerId}-${input.sequence}`,
    roomId: state.roomId,
    roomGeneration: state.roomGeneration,
    senderClientId: state.clientId,
    senderPeerId: state.peerId,
    sequence: input.sequence,
    type: input.type ?? "scene-update",
    payload: {
      elements: input.elements ?? [
        { id: "el-1", version: 1, versionNonce: 7, isDeleted: false },
      ],
    },
  };
}

function presenceMessageFrom(
  state: Extract<ConnectionState, { status: "connected" }>,
  sequence: number,
): PresenceMessage {
  return {
    protocolVersion: 1,
    messageId: `p-${state.peerId}-${sequence}`,
    roomId: state.roomId,
    roomGeneration: state.roomGeneration,
    senderClientId: state.clientId,
    senderPeerId: state.peerId,
    sequence,
    type: "presence",
    payload: {
      pointer: { x: 4, y: 8, tool: "pointer" },
      button: "up",
      username: "tester",
      selectedElementIds: [],
      idleState: "active",
    },
  };
}

describe("BroadcastChannel POC transport", () => {
  let hub: ReturnType<typeof createChannelHub>;
  let a: TransportProbe;
  let b: TransportProbe;

  beforeEach(() => {
    hub = createChannelHub();
    a = createProbe(hub);
    b = createProbe(hub);
  });

  it("discovers peers through the hello handshake in both directions", () => {
    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    expect(a.peersHistory.at(-1)).toHaveLength(1);

    b.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_B });

    const aPeers = a.peersHistory.at(-1);
    const bPeers = b.peersHistory.at(-1);
    expect(aPeers?.map((peer) => peer.clientId).sort()).toEqual([
      "client-a",
      "client-b",
    ]);
    expect(bPeers?.map((peer) => peer.clientId).sort()).toEqual([
      "client-a",
      "client-b",
    ]);
  });

  it("delivers protocol-validated scene and presence messages to other peers only", () => {
    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    b.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_B });

    const sceneResult = a.transport.sendSceneMessage(
      sceneMessageFrom(a.connectedState(), { sequence: 1 }),
    );
    const presenceResult = a.transport.sendPresenceMessage(
      presenceMessageFrom(a.connectedState(), 1),
    );

    expect(sceneResult).toEqual({ ok: true });
    expect(presenceResult).toEqual({ ok: true });
    expect(a.messages).toHaveLength(0);
    expect(b.messages.map((message) => message.type)).toEqual([
      "scene-update",
      "presence",
    ]);
    expect(b.messages[0]?.senderClientId).toBe("client-a");
  });

  it("rejects sends before connect and after identity changes", () => {
    expect(
      a.transport.sendSceneMessage(
        sceneMessageFrom(
          {
            status: "connected",
            roomId: ROOM_ID,
            clientId: CLIENT_A,
            peerId: "bc-nope" as never,
            roomGeneration: 1,
          },
          { sequence: 1 },
        ),
      ),
    ).toEqual({ ok: false, error: { code: "not-connected" } });

    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    const staleMessage = {
      ...sceneMessageFrom(a.connectedState(), { sequence: 1 }),
      senderPeerId: "bc-someone-else" as never,
    };
    expect(a.transport.sendSceneMessage(staleMessage)).toEqual({
      ok: false,
      error: { code: "stale-session" },
    });
  });

  it("refuses oversize payloads before posting them", () => {
    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    b.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_B });
    const oversize = sceneMessageFrom(a.connectedState(), {
      sequence: 1,
      elements: [
        {
          id: "el-big",
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          blob: "x".repeat(1_100_000),
        },
      ],
    });
    const result = a.transport.sendSceneMessage(oversize);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("oversize-payload");
    expect(b.messages).toHaveLength(0);
  });

  it("ignores malformed frames and undecodable protocol bytes", () => {
    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    const rogue = hub.create("drawstuff-collab-poc:room-bc");
    rogue.postMessage("garbage");
    rogue.postMessage({ kind: "hello", peerId: 42, clientId: null, isReply: false });
    rogue.postMessage({ kind: "scene", bytes: new TextEncoder().encode("not json") });
    rogue.postMessage({
      kind: "scene",
      bytes: new TextEncoder().encode(JSON.stringify({ protocolVersion: 99 })),
    });

    expect(a.messages).toHaveLength(0);
    expect(a.peersHistory.at(-1)).toHaveLength(1);
  });

  it("announces leave on disconnect and stays reusable for a reconnect", () => {
    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    b.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_B });
    const firstPeerId = a.connectedState().peerId;

    a.transport.disconnect();
    expect(a.transport.getConnectionState().status).toBe("disconnected");
    expect(b.peersHistory.at(-1)).toHaveLength(1);
    expect(hub.openChannelCount("drawstuff-collab-poc:room-bc")).toBe(1);

    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    expect(a.connectedState().peerId).not.toBe(firstPeerId);
    expect(b.peersHistory.at(-1)).toHaveLength(2);
  });

  it("tears down the channel, listeners and subscribers on close", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");

    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });
    expect(
      addListener.mock.calls.filter(([type]) => type === "pagehide"),
    ).toHaveLength(1);

    b.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_B });
    a.transport.close();

    expect(a.transport.getConnectionState().status).toBe("closed");
    expect(
      removeListener.mock.calls.filter(([type]) => type === "pagehide"),
    ).toHaveLength(1);
    expect(hub.openChannelCount("drawstuff-collab-poc:room-bc")).toBe(1);
    expect(b.peersHistory.at(-1)).toHaveLength(1);

    // Closed transports are terminal and silent.
    expect(() =>
      a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A }),
    ).toThrow(/closed/i);
    const messagesBefore = a.messages.length;
    b.transport.sendSceneMessage(
      sceneMessageFrom(b.connectedState(), { sequence: 1 }),
    );
    expect(a.messages).toHaveLength(messagesBefore);
  });

  it("scopes rooms by channel name", () => {
    const other = createBroadcastChannelTransport({ createChannel: hub.create });
    const otherMessages: CollaborationMessage[] = [];
    other.subscribe({ onMessage: (message) => otherMessages.push(message) });
    other.connect({
      roomId: roomIdSchema.parse("room-other"),
      clientId: CLIENT_B,
    });
    a.transport.connect({ roomId: ROOM_ID, clientId: CLIENT_A });

    a.transport.sendSceneMessage(
      sceneMessageFrom(a.connectedState(), { sequence: 1 }),
    );
    expect(otherMessages).toHaveLength(0);
    expect(a.peersHistory.at(-1)).toHaveLength(1);
  });
});
