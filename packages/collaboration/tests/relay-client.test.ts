import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeCollaborationMessage,
  encodeCollaborationMessage,
  type CollaborationMessage,
} from "../src/protocol.ts";
import {
  createRelayWebSocketTransport,
  type RelaySocketLike,
} from "../src/relay-client.ts";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayClientControl,
  RELAY_CLOSE_CODES,
  RELAY_KEEPALIVE_REQUEST,
  RELAY_KEEPALIVE_RESPONSE,
  type RelayServerControl,
} from "../src/relay-protocol.ts";
import type {
  ConnectionState,
  DisconnectReason,
  InboundMessageMeta,
  RoomPeer,
} from "../src/transport.ts";
import {
  connectedState,
  JOIN_TOKEN,
  PEER_A,
  PEER_B,
  presenceFromSession,
  presenceMessage,
  ROOM_ID,
  sceneFromSession,
  sceneMessage,
} from "./helpers.ts";
import type { MessageChannel } from "../src/codec.ts";

import { KEEPALIVE_INTERVAL_MS } from "../src/client-pacing.ts";

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  vi.useRealTimers();
});

class FakeSocket implements RelaySocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
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

  serverClose(code?: number): void {
    this.readyState = 3;
    this.onclose?.(code === undefined ? {} : { code });
  }
}

const joinedNotice = (
  overrides: Partial<Extract<RelayServerControl, { control: "joined" }>> = {},
): RelayServerControl => ({
  control: "joined",
  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
  roomId: ROOM_ID,
  peerId: PEER_A,
  roomGeneration: 3,
  role: "editor",
  peers: [{ peerId: PEER_A, role: "editor" }],
  ...overrides,
});

const encodedBytesOf = (message: CollaborationMessage): Uint8Array => {
  const encoded = encodeCollaborationMessage(message);
  if (!encoded.ok) throw new Error("expected encodable message");
  return encoded.bytes;
};

/** Wire size of one message once wrapped in a relay data frame. */
const wireSizeOf = (message: CollaborationMessage): number =>
  encodedBytesOf(message).byteLength + 1;

/** Frames a message the way a remote peer would, for inbound delivery tests. */
const remoteFrame = (
  message: CollaborationMessage,
  channel: MessageChannel,
): Uint8Array => encodeRelayDataFrame(channel, encodedBytesOf(message));

const remoteScene = (sequence: number): CollaborationMessage =>
  sceneMessage({ sequence, roomGeneration: 3, senderPeerId: PEER_B });

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
  cleanups.add(() => transport.close());
  const states: ConnectionState[] = [];
  const messages: CollaborationMessage[] = [];
  const metas: InboundMessageMeta[] = [];
  const peerUpdates: (readonly RoomPeer[])[] = [];
  transport.subscribe({
    onConnectionStateChange: (state) => states.push(state),
    onMessage: (message, meta) => {
      messages.push(message);
      metas.push(meta);
    },
    onRoomPeersChange: (peers) => peerUpdates.push(peers),
  });
  const connectAndJoin = (joinOptions?: {
    joined?: Partial<Extract<RelayServerControl, { control: "joined" }>>;
  }): FakeSocket => {
    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket created");
    socket.open();
    socket.receiveControl(joinedNotice(joinOptions?.joined));
    return socket;
  };
  return {
    transport,
    sockets,
    states,
    messages,
    metas,
    peerUpdates,
    connectAndJoin,
  };
}

describe("createRelayWebSocketTransport", () => {
  it("starts byte-exact keepalive only after joining; ACKs are optional", () => {
    vi.useFakeTimers();
    const { transport, sockets, messages, peerUpdates } = setup();
    transport.connect({ roomId: ROOM_ID, joinToken: JOIN_TOKEN });
    const socket = sockets[0]!;
    socket.open();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2);
    expect(socket.sentText).toHaveLength(1);
    socket.receiveControl(joinedNotice());
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS - 1);
    expect(socket.sentText).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.sentText.at(-1)).toBe(RELAY_KEEPALIVE_REQUEST);
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    expect(socket.sentText.slice(1)).toEqual([
      RELAY_KEEPALIVE_REQUEST,
      RELAY_KEEPALIVE_REQUEST,
    ]);
    socket.onmessage?.({ data: RELAY_KEEPALIVE_RESPONSE });
    expect(messages).toEqual([]);
    expect(peerUpdates).toHaveLength(1);
    expect(transport.getConnectionState().status).toBe("connected");
    expect(socket.sentBinary).toEqual([]);
  });

  it.each(["disconnect", "remote-close", "close", "protocol-error"] as const)(
    "clears keepalive after %s and gives reconnect its own timer",
    (reason) => {
      vi.useFakeTimers();
      const { transport, connectAndJoin } = setup();
      const oldSocket = connectAndJoin();
      if (reason === "remote-close") oldSocket.serverClose(1006);
      else if (reason === "protocol-error")
        oldSocket.receiveControl(joinedNotice());
      else transport[reason]();
      const oldWrites = oldSocket.sentText.length;
      expect(vi.getTimerCount()).toBe(0);
      if (reason !== "close") {
        const newSocket = connectAndJoin();
        vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
        expect(newSocket.sentText.at(-1)).toBe(RELAY_KEEPALIVE_REQUEST);
        expect(vi.getTimerCount()).toBe(1);
      } else vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
      expect(oldSocket.sentText).toHaveLength(oldWrites);
      transport.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports a keepalive send failure as transient and clears its timer", () => {
    vi.useFakeTimers();
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("socket failed");
    });
    expect(() => vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)).not.toThrow();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.closedWith?.code).toBe(1000);
  });

  it("connects, joins, and adopts the relay-assigned session identity", () => {
    const { transport, states, peerUpdates, connectAndJoin } = setup();
    const socket = connectAndJoin();

    expect(socket.binaryType).toBe("arraybuffer");
    const join = parseRelayClientControl(socket.sentText[0] ?? "");
    expect(join).toEqual({
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: ROOM_ID,
      token: JOIN_TOKEN,
    });

    expect(states.map((state) => state.status)).toEqual([
      "connecting",
      "connected",
    ]);
    const state = connectedState(transport);
    expect(state.peerId).toBe(PEER_A);
    expect(state.roomGeneration).toBe(3);
    // The role travels with membership so both client-side elections (who
    // answers a newcomer, who writes the durable snapshot) can skip viewers.
    expect(peerUpdates.at(-1)).toEqual([{ peerId: PEER_A, role: "editor" }]);
  });

  it("sends each message as its encoded bytes on the matching channel", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);
    const scene = sceneFromSession(state, { sequence: 1 });
    const presence = presenceFromSession(state, { sequence: 1 });

    expect(transport.sendSceneMessage(scene)).toEqual({ ok: true });
    expect(transport.sendPresenceMessage(presence)).toEqual({ ok: true });

    // Sent synchronously, and byte-identical to framing the codec output:
    // rooms are not end-to-end encrypted, WSS protects the frame in transit.
    expect(socket.sentBinary).toEqual([
      encodeRelayDataFrame("scene", encodedBytesOf(scene)),
      encodeRelayDataFrame("presence", encodedBytesOf(presence)),
    ]);
    const presenceFrame = decodeRelayDataFrame(socket.sentBinary[1]!);
    if (!presenceFrame) throw new Error("undecodable data frame");
    expect(new TextDecoder().decode(presenceFrame.payload)).toContain("eric");
    expect(
      decodeCollaborationMessage(presenceFrame.payload, "presence"),
    ).toEqual({ ok: true, message: presence });
  });

  it("keeps scene frames in send order", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);

    for (let sequence = 1; sequence <= 12; sequence += 1) {
      expect(
        transport.sendSceneMessage(sceneFromSession(state, { sequence })).ok,
      ).toBe(true);
    }

    const sequences = socket.sentBinary.map((frame) => {
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) throw new Error("undecodable data frame");
      const decoded = decodeCollaborationMessage(dataFrame.payload, "scene");
      if (!decoded.ok) throw new Error("expected decodable message");
      return decoded.message.sequence;
    });
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("rejects sends before the join acknowledgment", () => {
    const { transport, sockets } = setup();
    transport.connect({
      roomId: ROOM_ID,
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

  it("refuses a viewer's scene send locally but still sends its presence", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin({
      joined: { role: "viewer", peers: [{ peerId: PEER_A, role: "viewer" }] },
    });
    const state = connectedState(transport);
    expect(state.role).toBe("viewer");

    // The relay would close the whole connection for this frame.
    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })),
    ).toEqual({ ok: false, error: { code: "read-only-role" } });
    expect(
      transport.sendPresenceMessage(presenceFromSession(state, { sequence: 1 }))
        .ok,
    ).toBe(true);
    expect(socket.sentBinary).toHaveLength(1);
    expect(socket.sentBinary[0]?.[0]).toBe(0x02);
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

  it("counts the frame itself against the buffered-bytes budget", () => {
    // Sized from the real frames: the budget admits exactly one scene frame on
    // top of what the socket already holds, and nothing more.
    const probe = setup();
    probe.connectAndJoin();
    const probeState = connectedState(probe.transport);
    const sceneBytes = wireSizeOf(
      sceneFromSession(probeState, { sequence: 1 }),
    );
    const presenceBytes = wireSizeOf(
      presenceFromSession(probeState, { sequence: 1 }),
    );
    probe.transport.close();

    const { transport, connectAndJoin } = setup({
      maxBufferedBytes: sceneBytes + presenceBytes - 1,
    });
    const socket = connectAndJoin();
    const state = connectedState(transport);

    socket.bufferedAmount = presenceBytes - 1;
    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    // Both channels share one socket: the undrained scene frame leaves no room
    // for presence.
    socket.bufferedAmount += sceneBytes;
    expect(
      transport.sendPresenceMessage(
        presenceFromSession(state, { sequence: 1 }),
      ),
    ).toEqual({ ok: false, error: { code: "queue-overflow" } });

    // Once the socket drains, presence fits again.
    socket.bufferedAmount = 0;
    expect(
      transport.sendPresenceMessage(presenceFromSession(state, { sequence: 1 }))
        .ok,
    ).toBe(true);
  });

  it("reports a send the socket throws on as not-connected", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("socket failed");
    });

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })),
    ).toEqual({ ok: false, error: { code: "not-connected" } });
    // Teardown is left to the socket's own close event.
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("decodes a received frame and delivers it with its encoded size", () => {
    const { transport, messages, metas, connectAndJoin } = setup();
    const socket = connectAndJoin();
    const scene = remoteScene(1);
    const presence = presenceMessage({
      sequence: 1,
      roomGeneration: 3,
      senderPeerId: PEER_B,
    });

    socket.receiveFrame(remoteFrame(scene, "scene"));
    socket.receiveFrame(remoteFrame(presence, "presence"));

    // Synchronous: delivered before `receiveFrame` returns.
    expect(messages).toEqual([scene, presence]);
    expect(metas).toEqual([
      { byteLength: encodedBytesOf(scene).byteLength },
      { byteLength: encodedBytesOf(presence).byteLength },
    ]);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("drops malformed frames without disturbing the session", () => {
    const { transport, messages, connectAndJoin } = setup();
    const socket = connectAndJoin();
    const remote = remoteScene(1);

    // A scene message delivered on the presence channel fails that channel's
    // schema, so it never reaches a subscriber.
    socket.receiveFrame(
      encodeRelayDataFrame("presence", encodedBytesOf(remote)),
    );
    // Not JSON, empty, an unknown channel byte, and a non-binary payload.
    socket.receiveFrame(new Uint8Array([0x01, 0x7f, 1, 2]));
    socket.receiveFrame(new Uint8Array([0x01]));
    socket.receiveFrame(new Uint8Array([0x7f, 1, 2]));
    socket.onmessage?.({ data: { not: "bytes" } });

    socket.receiveFrame(remoteFrame(remote, "scene"));
    expect(messages).toEqual([remote]);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("ignores data frames that arrive before the join acknowledgment", () => {
    const { transport, sockets, messages } = setup();
    transport.connect({ roomId: ROOM_ID, joinToken: JOIN_TOKEN });
    const socket = sockets[0]!;
    socket.open();

    socket.receiveFrame(remoteFrame(remoteScene(1), "scene"));
    expect(messages).toEqual([]);
  });

  it("keeps delivering to later subscribers when an earlier one throws", () => {
    const { messages, transport, connectAndJoin } = setup();
    // Registered after setup's own collector and before the late collector, so
    // the throw happens mid-fanout.
    transport.subscribe({
      onMessage: () => {
        throw new Error("subscriber A failed");
      },
    });
    const late: CollaborationMessage[] = [];
    transport.subscribe({ onMessage: (message) => late.push(message) });
    const socket = connectAndJoin();

    const first = remoteScene(1);
    socket.receiveFrame(remoteFrame(first, "scene"));
    expect(late).toEqual([first]);
    expect(messages).toEqual([first]);

    // The throw did not break the receive path: later frames still deliver.
    const second = remoteScene(2);
    socket.receiveFrame(remoteFrame(second, "scene"));
    expect(late).toEqual([first, second]);
    expect(messages).toEqual([first, second]);
  });

  it("keeps notifying state and peers when a subscriber throws", () => {
    const { transport, connectAndJoin } = setup();
    transport.subscribe({
      onConnectionStateChange: () => {
        throw new Error("state subscriber failed");
      },
      onRoomPeersChange: () => {
        throw new Error("peers subscriber failed");
      },
    });
    const states: ConnectionState[] = [];
    const peerUpdates: (readonly RoomPeer[])[] = [];
    transport.subscribe({
      onConnectionStateChange: (state) => states.push(state),
      onRoomPeersChange: (peers) => peerUpdates.push(peers),
    });

    // Without isolation the throw would propagate out of the socket callback
    // before the later subscriber ever heard about the join.
    connectAndJoin();
    expect(states.at(-1)?.status).toBe("connected");
    expect(peerUpdates).toHaveLength(1);
  });

  it("degrades to disconnected when the relay closes the socket", () => {
    const { transport, connectAndJoin } = setup();
    const socket = connectAndJoin();

    // No close code at all: a socket that failed before any close frame, which
    // is what a network failure looks like. Retryable.
    socket.serverClose();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
  });

  it("reports the relay's close code as the reason recovery acts on", () => {
    const cases: {
      code: number | undefined;
      reason: DisconnectReason;
    }[] = [
      { code: RELAY_CLOSE_CODES.slowConsumer, reason: "transient" },
      { code: RELAY_CLOSE_CODES.roomAtCapacity, reason: "transient" },
      { code: RELAY_CLOSE_CODES.joinTimeout, reason: "transient" },
      { code: RELAY_CLOSE_CODES.unauthorized, reason: "unauthorized" },
      {
        code: RELAY_CLOSE_CODES.membershipRevoked,
        reason: "membership-revoked",
      },
      { code: RELAY_CLOSE_CODES.roomEnded, reason: "room-ended" },
      { code: RELAY_CLOSE_CODES.protocolViolation, reason: "protocol" },
      { code: RELAY_CLOSE_CODES.readOnlyRole, reason: "protocol" },
      // A normal close from the server side is still an unexpected end of
      // session for the client, so it is worth retrying.
      { code: 1000, reason: "transient" },
      { code: 1006, reason: "transient" },
    ];

    for (const { code, reason } of cases) {
      const { transport, connectAndJoin } = setup();
      connectAndJoin().serverClose(code);
      expect(transport.getConnectionState()).toEqual({
        status: "disconnected",
        reason,
      });
    }
  });

  it("clears a stale disconnect reason when reconnecting", () => {
    const { transport, connectAndJoin, sockets } = setup();
    connectAndJoin().serverClose(RELAY_CLOSE_CODES.slowConsumer);

    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    expect(transport.getConnectionState()).toEqual({
      status: "connecting",
      roomId: ROOM_ID,
    });

    // A reason must never outlive the connection it describes: the caller ends
    // this one, so that is what it reports.
    sockets[1]?.open();
    transport.disconnect();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "idle",
    });
  });

  it("treats a joined notice for the wrong room as a broken connection", () => {
    const { transport, sockets } = setup();
    transport.connect({
      roomId: ROOM_ID,
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
      reason: "protocol",
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
    socket.receiveFrame(remoteFrame(remoteScene(1), "scene"));
    socket.serverClose();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "idle",
    });
    expect(messages).toHaveLength(0);
  });

  it("close() is terminal and refuses further connects", () => {
    const { transport, states, connectAndJoin } = setup();
    const socket = connectAndJoin();

    transport.close();
    expect(parseRelayClientControl(socket.sentText.at(-1) ?? "")).toEqual({
      control: "leave",
    });
    expect(socket.closedWith?.code).toBe(1000);
    expect(transport.getConnectionState()).toEqual({ status: "closed" });
    expect(states.at(-1)?.status).toBe("closed");
    expect(() =>
      transport.connect({
        roomId: ROOM_ID,
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
        joinToken: JOIN_TOKEN,
      }),
    ).toThrow(/already connected/i);
  });
});
