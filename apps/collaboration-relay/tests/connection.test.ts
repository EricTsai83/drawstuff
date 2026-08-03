import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientIdSchema,
  peerIdSchema,
  roomIdSchema,
  MAX_PRESENCE_MESSAGE_BYTES,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  parseRelayServerControl,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import {
  createRelayConnection,
  type RelayConnection,
  type RelayConnectionLimits,
  type RelayConnectionSocket,
} from "../src/connection.ts";
import { createInMemoryRoomFanout, type RoomFanout } from "../src/fanout.ts";

const ROOM_ID = roomIdSchema.parse("room-conn");

class FakeSocket implements RelayConnectionSocket {
  bufferedAmount = 0;
  readonly sentText: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | undefined;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.sentText.push(data);
    else this.sentBinary.push(data);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }
}

const DEFAULT_LIMITS: RelayConnectionLimits = {
  maxConnectionsPerRoom: 8,
  maxBufferedBytes: 1_024,
  presenceDropBufferedBytes: 64,
  joinTimeoutMs: 5_000,
};

let peerCounter = 0;

function setup(options: {
  fanout?: RoomFanout;
  limits?: Partial<RelayConnectionLimits>;
} = {}): {
  socket: FakeSocket;
  connection: RelayConnection;
  fanout: RoomFanout;
  join: (clientName?: string) => void;
} {
  const fanout =
    options.fanout ?? createInMemoryRoomFanout({ now: () => 1_000 });
  const socket = new FakeSocket();
  const connection = createRelayConnection({
    socket,
    fanout,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    generatePeerId: () => peerIdSchema.parse(`peer-${++peerCounter}`),
  });
  const join = (clientName = "client-a"): void => {
    connection.handleTextFrame(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: clientIdSchema.parse(clientName),
      }),
    );
  };
  return { socket, connection, fanout, join };
}

const sceneFrame = (size = 4): Uint8Array => {
  const frame = new Uint8Array(size);
  frame[0] = 0x01;
  return frame;
};

const presenceFrame = (size = 4): Uint8Array => {
  const frame = new Uint8Array(size);
  frame[0] = 0x02;
  return frame;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRelayConnection", () => {
  it("acknowledges a join with session identity and membership", () => {
    const { socket, connection, fanout, join } = setup();
    join();

    expect(connection.isJoined()).toBe(true);
    expect(fanout.memberCount(ROOM_ID)).toBe(1);
    const ack = parseRelayServerControl(socket.sentText[0] ?? "");
    expect(ack?.control).toBe("joined");
    if (ack?.control !== "joined") throw new Error("expected joined ack");
    expect(ack.roomId).toBe(ROOM_ID);
    expect(ack.roomGeneration).toBe(1_000);
    expect(ack.peers).toEqual([
      { peerId: ack.peerId, clientId: "client-a" },
    ]);
  });

  it("closes on malformed and oversize control frames", () => {
    const malformed = setup();
    malformed.connection.handleTextFrame("not json");
    expect(malformed.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.protocolViolation,
    );

    const oversize = setup();
    oversize.connection.handleTextFrame(
      "x".repeat(MAX_RELAY_CONTROL_FRAME_BYTES + 1),
    );
    expect(oversize.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.protocolViolation,
    );

    // The budget is wire bytes: a multibyte string whose UTF-16 length is
    // under the limit but whose UTF-8 encoding is over it must be refused.
    const multibyte = setup();
    multibyte.connection.handleTextFrame(
      "妖".repeat(Math.ceil(MAX_RELAY_CONTROL_FRAME_BYTES / 3) + 1),
    );
    expect(multibyte.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.protocolViolation,
    );
  });

  it("closes on a duplicate join", () => {
    const { socket, fanout, join } = setup();
    join();
    join();
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.protocolViolation);
    // The violation also released the membership taken by the first join.
    expect(fanout.memberCount(ROOM_ID)).toBe(0);
  });

  it("closes data frames sent before joining", () => {
    const { socket, connection } = setup();
    connection.handleBinaryFrame(sceneFrame());
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.protocolViolation);
  });

  it("closes on unknown data frames and channel-budget violations", () => {
    const unknown = setup();
    unknown.join();
    unknown.connection.handleBinaryFrame(new Uint8Array([0x7f, 1]));
    expect(unknown.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.protocolViolation,
    );

    const oversize = setup();
    oversize.join();
    oversize.connection.handleBinaryFrame(
      presenceFrame(MAX_PRESENCE_MESSAGE_BYTES + 2),
    );
    expect(oversize.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.protocolViolation,
    );
  });

  it("refuses joins beyond the per-room connection limit", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const first = setup({ fanout, limits: { maxConnectionsPerRoom: 1 } });
    first.join();
    const second = setup({ fanout, limits: { maxConnectionsPerRoom: 1 } });
    second.join("client-b");

    expect(second.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.roomAtCapacity,
    );
    expect(fanout.memberCount(ROOM_ID)).toBe(1);
  });

  it("routes data frames between two joined connections", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join("client-a");
    b.join("client-b");

    const frame = sceneFrame();
    a.connection.handleBinaryFrame(frame);
    expect(b.socket.sentBinary).toEqual([frame]);
    expect(a.socket.sentBinary).toHaveLength(0);
  });

  it("drops presence for a congested receiver but keeps scene flowing", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join("client-a");
    b.join("client-b");

    b.socket.bufferedAmount = DEFAULT_LIMITS.presenceDropBufferedBytes + 1;
    a.connection.handleBinaryFrame(presenceFrame());
    a.connection.handleBinaryFrame(sceneFrame());

    expect(b.socket.closedWith).toBeUndefined();
    expect(b.socket.sentBinary).toEqual([sceneFrame()]);
  });

  it("disconnects a slow consumer instead of queueing scene frames", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join("client-a");
    b.join("client-b");

    b.socket.bufferedAmount = DEFAULT_LIMITS.maxBufferedBytes + 1;
    a.connection.handleBinaryFrame(sceneFrame());

    expect(b.socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.slowConsumer);
    expect(b.socket.sentBinary).toHaveLength(0);
    // The slow consumer's membership was released synchronously.
    expect(fanout.memberCount(ROOM_ID)).toBe(1);
  });

  it("handles a leave control with a normal close and cleanup", () => {
    const { socket, connection, fanout, join } = setup();
    join();
    connection.handleTextFrame(encodeRelayControl({ control: "leave" }));

    expect(socket.closedWith?.code).toBe(1000);
    expect(connection.isJoined()).toBe(false);
    expect(fanout.memberCount(ROOM_ID)).toBe(0);
  });

  it("releases membership when the socket closes abruptly", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join("client-a");
    b.join("client-b");

    a.connection.handleSocketClosed();
    expect(fanout.memberCount(ROOM_ID)).toBe(1);
    const lastPeers = parseRelayServerControl(b.socket.sentText.at(-1) ?? "");
    expect(lastPeers?.control).toBe("peers");
    if (lastPeers?.control !== "peers") throw new Error("expected peers");
    expect(lastPeers.peers.map((peer) => peer.clientId)).toEqual(["client-b"]);
  });

  it("closes sockets that never join within the deadline", () => {
    const { socket } = setup({ limits: { joinTimeoutMs: 500 } });
    vi.advanceTimersByTime(499);
    expect(socket.closedWith).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.joinTimeout);
  });

  it("cancels the join deadline once joined", () => {
    const { socket, join } = setup({ limits: { joinTimeoutMs: 500 } });
    join();
    vi.advanceTimersByTime(10_000);
    expect(socket.closedWith).toBeUndefined();
  });

  it("ignores frames after the connection ended", () => {
    const { socket, connection } = setup();
    connection.handleSocketClosed();
    connection.handleBinaryFrame(sceneFrame());
    connection.handleTextFrame(encodeRelayControl({ control: "leave" }));
    expect(socket.closedWith).toBeUndefined();
    expect(socket.sentText).toHaveLength(0);
  });
});
