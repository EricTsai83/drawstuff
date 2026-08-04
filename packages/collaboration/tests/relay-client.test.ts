import { describe, expect, it } from "vitest";

import {
  encodeCollaborationMessage,
  type CollaborationMessage,
} from "../src/protocol.ts";
import {
  createRelayWebSocketTransport,
  type RelaySocketLike,
} from "../src/relay-client.ts";
import {
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayClientControl,
  type RelayServerControl,
} from "../src/relay-protocol.ts";
import type { ConnectionState, RoomPeer } from "../src/transport.ts";
import {
  CLIENT_A,
  CLIENT_B,
  connectedState,
  JOIN_TOKEN,
  PEER_A,
  PEER_B,
  presenceFromSession,
  ROOM_ID,
  sceneFromSession,
  sceneMessage,
} from "./helpers.ts";

class FakeSocket implements RelaySocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sentText: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.sentText.push(data);
    else this.sentBinary.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receiveControl(control: RelayServerControl): void {
    this.onmessage?.({ data: encodeRelayControl(control) });
  }

  receiveFrame(frame: Uint8Array): void {
    // Delivered as ArrayBuffer, matching binaryType = "arraybuffer".
    this.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ),
    });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const joinedNotice = (
  overrides: Partial<Extract<RelayServerControl, { control: "joined" }>> = {},
): RelayServerControl => ({
  control: "joined",
  protocolVersion: 1,
  roomId: ROOM_ID,
  peerId: PEER_A,
  roomGeneration: 3,
  role: "editor",
  peers: [{ peerId: PEER_A, clientId: CLIENT_A }],
  ...overrides,
});

function setup(options: { maxBufferedBytes?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const transport = createRelayWebSocketTransport({
    url: "ws://relay.test",
    maxBufferedBytes: options.maxBufferedBytes,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const states: ConnectionState[] = [];
  const messages: CollaborationMessage[] = [];
  const peerUpdates: (readonly RoomPeer[])[] = [];
  transport.subscribe({
    onConnectionStateChange: (state) => states.push(state),
    onMessage: (message) => messages.push(message),
    onRoomPeersChange: (peers) => peerUpdates.push(peers),
  });
  const connectAndJoin = (options?: {
    joined?: Partial<Extract<RelayServerControl, { control: "joined" }>>;
  }): FakeSocket => {
    transport.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket created");
    socket.open();
    socket.receiveControl(joinedNotice(options?.joined));
    return socket;
  };
  return { transport, sockets, states, messages, peerUpdates, connectAndJoin };
}

describe("createRelayWebSocketTransport", () => {
  it("connects, joins, and adopts the relay-assigned session identity", () => {
    const { transport, states, peerUpdates, connectAndJoin } = setup();
    const socket = connectAndJoin();

    expect(socket.binaryType).toBe("arraybuffer");
    const join = parseRelayClientControl(socket.sentText[0] ?? "");
    expect(join).toEqual({
      control: "join",
      protocolVersion: 1,
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      token: JOIN_TOKEN,
    });

    expect(states.map((state) => state.status)).toEqual([
      "connecting",
      "connected",
    ]);
    const state = connectedState(transport);
    expect(state.peerId).toBe(PEER_A);
    expect(state.roomGeneration).toBe(3);
    expect(peerUpdates.at(-1)).toEqual([
      { peerId: PEER_A, clientId: CLIENT_A },
    ]);
  });

  it("sends codec-encoded frames on the matching channel", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    expect(
      transport.sendPresenceMessage(presenceFromSession(state, { sequence: 1 }))
        .ok,
    ).toBe(true);

    expect(socket.sentBinary).toHaveLength(2);
    expect(socket.sentBinary[0]?.[0]).toBe(0x01);
    expect(socket.sentBinary[1]?.[0]).toBe(0x02);
  });

  it("rejects sends before the join acknowledgment", () => {
    const { transport, sockets } = setup();
    transport.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    sockets[0]?.open();

    const result = transport.sendSceneMessage(sceneMessage({ sequence: 1 }));
    expect(result).toEqual({
      ok: false,
      error: { code: "not-connected" },
    });
  });

  it("rejects messages that do not match the session identity", () => {
    const { transport, connectAndJoin } = setup();
    connectAndJoin();
    const state = connectedState(transport);

    const stale = sceneFromSession(state, { sequence: 1 });
    const result = transport.sendSceneMessage({
      ...stale,
      roomGeneration: state.roomGeneration + 1,
    });
    expect(result).toEqual({ ok: false, error: { code: "stale-session" } });
  });

  it("fails with queue-overflow when the socket buffer is over budget", () => {
    const { transport, connectAndJoin } = setup({ maxBufferedBytes: 8 });
    const socket = connectAndJoin();
    const state = connectedState(transport);
    socket.bufferedAmount = 9;

    const result = transport.sendSceneMessage(
      sceneFromSession(state, { sequence: 1 }),
    );
    expect(result).toEqual({ ok: false, error: { code: "queue-overflow" } });
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("delivers decoded remote messages and drops undecodable frames", () => {
    const { transport, messages, connectAndJoin } = setup();
    const socket = connectAndJoin();

    const remote = sceneMessage({
      sequence: 1,
      roomGeneration: 3,
      senderClientId: CLIENT_B,
      senderPeerId: PEER_B,
    });
    const encoded = encodeCollaborationMessage(remote);
    if (!encoded.ok) throw new Error("expected encodable message");
    socket.receiveFrame(encodeRelayDataFrame("scene", encoded.bytes));
    // Scene payload on the presence channel must be rejected by the codec.
    socket.receiveFrame(encodeRelayDataFrame("presence", encoded.bytes));
    socket.receiveFrame(new Uint8Array([0x7f, 1, 2]));

    expect(messages).toEqual([remote]);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("degrades to disconnected when the relay closes the socket", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();

    socket.serverClose();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
    });
  });

  it("treats a joined notice for the wrong room as a broken connection", () => {
    const { transport, sockets } = setup();
    transport.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    const socket = sockets[0];
    socket?.open();
    socket?.receiveControl(
      joinedNotice({
        roomId: ROOM_ID.replace("alpha", "beta") as typeof ROOM_ID,
      }),
    );

    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
    });
    expect(socket?.closedWith?.code).toBe(1000);
  });

  it("supports reconnecting after a disconnect with a fresh socket", () => {
    const { transport, sockets, connectAndJoin } = setup();
    const first = connectAndJoin();

    transport.disconnect();
    expect(parseRelayClientControl(first.sentText.at(-1) ?? "")).toEqual({
      control: "leave",
    });
    expect(first.closedWith?.code).toBe(1000);
    expect(transport.getConnectionState().status).toBe("disconnected");

    transport.connect({
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      joinToken: JOIN_TOKEN,
    });
    const second = sockets.at(-1);
    expect(second).not.toBe(first);
    second?.open();
    second?.receiveControl(joinedNotice({ peerId: PEER_B, roomGeneration: 4 }));
    expect(connectedState(transport).peerId).toBe(PEER_B);
  });

  it("ignores events from a socket abandoned by disconnect", () => {
    const { transport, connectAndJoin, messages } = setup();
    const socket = connectAndJoin();
    transport.disconnect();

    // Late events from the old socket must not resurrect the session.
    socket.receiveControl(joinedNotice());
    socket.serverClose();
    expect(transport.getConnectionState().status).toBe("disconnected");
    expect(messages).toHaveLength(0);
  });

  it("close() is terminal and refuses further connects", () => {
    const { transport, states, connectAndJoin } = setup();
    connectAndJoin();

    transport.close();
    expect(transport.getConnectionState()).toEqual({ status: "closed" });
    expect(states.at(-1)?.status).toBe("closed");
    expect(() =>
      transport.connect({
        roomId: ROOM_ID,
        clientId: CLIENT_A,
        joinToken: JOIN_TOKEN,
      }),
    ).toThrow(/closed/i);
    expect(transport.sendSceneMessage(sceneMessage({ sequence: 1 }))).toEqual({
      ok: false,
      error: { code: "not-connected" },
    });
  });

  it("throws when connecting an already-connected transport", () => {
    const { transport, connectAndJoin } = setup();
    connectAndJoin();
    expect(() =>
      transport.connect({
        roomId: ROOM_ID,
        clientId: CLIENT_A,
        joinToken: JOIN_TOKEN,
      }),
    ).toThrow(/already connected/i);
  });
});
