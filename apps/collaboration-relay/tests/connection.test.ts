import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientIdSchema,
  peerIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  maxRelayDataFrameBytesFor,
  parseRelayServerControl,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import {
  MAX_JOIN_TOKEN_TTL_SECONDS,
  roomChannelKey,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";

import {
  createRelayConnection,
  type RelayConnection,
  type RelayConnectionLimits,
  type RelayConnectionSocket,
} from "../src/connection.ts";
import { createInMemoryRoomFanout, type RoomFanout } from "../src/fanout.ts";
import {
  createSubjectRateLimiter,
  type SubjectRateLimiter,
} from "../src/rate-limit.ts";
import {
  createRelaySessionRegistry,
  type RelaySessionRegistry,
} from "../src/sessions.ts";
import {
  issueJoinToken,
  TEST_NOW_MS,
  TEST_NOW_SECONDS,
  TEST_ROOM_TOKEN_SECRET,
} from "./support/room-tokens.ts";

const ROOM_ID = roomIdSchema.parse("room-conn");
const ROOM_CHANNEL = roomChannelKey(ROOM_ID, 1);

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
  maxRooms: 8,
  maxBufferedBytes: 1_024,
  presenceDropBufferedBytes: 64,
  joinTimeoutMs: 5_000,
  // Far above anything the non-rate-limit tests reach, so the budgets never
  // become an invisible precondition of an unrelated assertion. The tests that
  // exercise them narrow these deliberately.
  idleTimeoutMs: 60 * 60_000,
  rateLimits: {
    sceneFramesPerSecond: 1_000,
    sceneFramesBurst: 1_000,
    sceneBytesPerSecond: 16 * 1_048_576,
    sceneBytesBurst: 16 * 1_048_576,
    presenceFramesPerSecond: 1_000,
    presenceFramesBurst: 1_000,
  },
};

let peerCounter = 0;

function setup(
  options: {
    fanout?: RoomFanout;
    sessions?: RelaySessionRegistry;
    limits?: Partial<RelayConnectionLimits>;
    subjectRateLimiter?: SubjectRateLimiter;
    now?: () => number;
    /** Elapsed-time source for the rate budgets and the idle deadline. Defaults
     *  to `now`, so a test driving one clock drives both. */
    monotonicNow?: () => number;
  } = {},
): {
  socket: FakeSocket;
  connection: RelayConnection;
  fanout: RoomFanout;
  sessions: RelaySessionRegistry;
  join: (joinOptions?: {
    clientName?: string;
    role?: RoomRole;
    authGeneration?: number;
    subject?: string;
    roomExpiresAtSeconds?: number;
    token?: string;
  }) => void;
} {
  const fanout =
    options.fanout ?? createInMemoryRoomFanout({ now: () => 1_000 });
  const sessions = options.sessions ?? createRelaySessionRegistry();
  const socket = new FakeSocket();
  const connection = createRelayConnection({
    socket,
    fanout,
    sessions,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    subjectRateLimiter:
      options.subjectRateLimiter ??
      createSubjectRateLimiter({
        now: options.monotonicNow ?? options.now ?? (() => TEST_NOW_MS),
      }),
    generatePeerId: () => peerIdSchema.parse(`peer-${++peerCounter}`),
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
    now: options.now ?? (() => TEST_NOW_MS),
    monotonicNow: options.monotonicNow ?? options.now ?? (() => TEST_NOW_MS),
  });
  const join = (
    joinOptions: {
      clientName?: string;
      role?: RoomRole;
      authGeneration?: number;
      subject?: string;
      roomExpiresAtSeconds?: number;
      token?: string;
    } = {},
  ): void => {
    const clientId = clientIdSchema.parse(joinOptions.clientName ?? "client-a");
    connection.handleTextFrame(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId,
        token:
          joinOptions.token ??
          issueJoinToken({
            roomId: ROOM_ID,
            clientId,
            role: joinOptions.role,
            authGeneration: joinOptions.authGeneration,
            subject: joinOptions.subject,
            roomExpiresAtSeconds: joinOptions.roomExpiresAtSeconds,
          }),
      }),
    );
  };
  return { socket, connection, fanout, sessions, join };
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
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);
    const ack = parseRelayServerControl(socket.sentText[0] ?? "");
    expect(ack?.control).toBe("joined");
    if (ack?.control !== "joined") throw new Error("expected joined ack");
    expect(ack.roomId).toBe(ROOM_ID);
    expect(ack.roomGeneration).toBe(1_000);
    // The role in the membership snapshot comes from the verified token, so a
    // client's elections agree with what the relay actually enforces.
    expect(ack.peers).toEqual([
      { peerId: ack.peerId, clientId: "client-a", role: ack.role },
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
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(0);
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
      presenceFrame(maxRelayDataFrameBytesFor("presence") + 2),
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
    second.join({ clientName: "client-b" });

    expect(second.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.roomAtCapacity,
    );
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);
  });

  it("routes data frames between two joined connections", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join({ clientName: "client-a" });
    b.join({ clientName: "client-b" });

    const frame = sceneFrame();
    a.connection.handleBinaryFrame(frame);
    expect(b.socket.sentBinary).toEqual([frame]);
    expect(a.socket.sentBinary).toHaveLength(0);
  });

  it("drops presence for a congested receiver but keeps scene flowing", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join({ clientName: "client-a" });
    b.join({ clientName: "client-b" });

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
    a.join({ clientName: "client-a" });
    b.join({ clientName: "client-b" });

    b.socket.bufferedAmount = DEFAULT_LIMITS.maxBufferedBytes + 1;
    a.connection.handleBinaryFrame(sceneFrame());

    expect(b.socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.slowConsumer);
    expect(b.socket.sentBinary).toHaveLength(0);
    // The slow consumer's membership was released synchronously.
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);
  });

  it("handles a leave control with a normal close and cleanup", () => {
    const { socket, connection, fanout, join } = setup();
    join();
    connection.handleTextFrame(encodeRelayControl({ control: "leave" }));

    expect(socket.closedWith?.code).toBe(1000);
    expect(connection.isJoined()).toBe(false);
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(0);
  });

  it("releases membership when the socket closes abruptly", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const a = setup({ fanout });
    const b = setup({ fanout });
    a.join({ clientName: "client-a" });
    b.join({ clientName: "client-b" });

    a.connection.handleSocketClosed();
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);
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

describe("relay connection authorization", () => {
  it("echoes the granted role in the join acknowledgment", () => {
    const { socket, join } = setup();
    join({ role: "viewer" });
    const ack = parseRelayServerControl(socket.sentText[0] ?? "");
    if (ack?.control !== "joined") throw new Error("expected joined ack");
    expect(ack.role).toBe("viewer");
  });

  it.each([
    [
      "a token signed with another secret",
      () =>
        issueJoinToken({
          roomId: ROOM_ID,
          clientId: clientIdSchema.parse("client-a"),
          secret: "an-entirely-different-secret-0123456789",
        }),
    ],
    [
      "a tampered payload",
      () => {
        const token = issueJoinToken({
          roomId: ROOM_ID,
          clientId: clientIdSchema.parse("client-a"),
          role: "viewer",
        });
        const [payload = "", signature = ""] = token.split(".");
        const claims = JSON.parse(
          Buffer.from(payload, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        claims.role = "editor";
        const forged = Buffer.from(JSON.stringify(claims), "utf8").toString(
          "base64url",
        );
        return `${forged}.${signature}`;
      },
    ],
    [
      "an expired token",
      () =>
        issueJoinToken({
          roomId: ROOM_ID,
          clientId: clientIdSchema.parse("client-a"),
          issuedAtSeconds: TEST_NOW_SECONDS - 3_600,
          ttlSeconds: 60,
        }),
    ],
    [
      "a token minted for another room",
      () =>
        issueJoinToken({
          roomId: roomIdSchema.parse("room-other"),
          clientId: clientIdSchema.parse("client-a"),
        }),
    ],
    [
      "a token minted for another client instance",
      () =>
        issueJoinToken({
          roomId: ROOM_ID,
          clientId: clientIdSchema.parse("client-zzz"),
        }),
    ],
    ["a token that is not a token at all", () => "garbage"],
  ])("refuses %s without joining a channel", (_label, mintToken) => {
    const { socket, connection, fanout, sessions, join } = setup();
    join({ token: mintToken() });

    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.unauthorized);
    expect(connection.isJoined()).toBe(false);
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(0);
    expect(sessions.sessionCount()).toBe(0);
    expect(socket.sentText).toHaveLength(0);
  });

  it("refuses a join frame without a token", () => {
    const { socket, connection } = setup();
    connection.handleTextFrame(
      JSON.stringify({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: "client-a",
      }),
    );
    // No token means the frame does not even parse as a join request.
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.protocolViolation);
    expect(connection.isJoined()).toBe(false);
  });

  it("closes a viewer that publishes a scene frame but allows presence", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const editor = setup({ fanout });
    const viewer = setup({ fanout });
    editor.join({ clientName: "client-a" });
    viewer.join({ clientName: "client-b", role: "viewer" });

    viewer.connection.handleBinaryFrame(presenceFrame());
    expect(viewer.socket.closedWith).toBeUndefined();
    expect(editor.socket.sentBinary).toEqual([presenceFrame()]);

    viewer.connection.handleBinaryFrame(sceneFrame());
    expect(viewer.socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.readOnlyRole);
    // The refused frame was never routed to the other member.
    expect(editor.socket.sentBinary).toEqual([presenceFrame()]);
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);
  });

  it("routes a rotated generation as a disjoint channel", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const oldGeneration = setup({ fanout });
    const newGeneration = setup({ fanout });
    oldGeneration.join({ clientName: "client-a", authGeneration: 1 });
    newGeneration.join({ clientName: "client-b", authGeneration: 2 });

    oldGeneration.connection.handleBinaryFrame(sceneFrame());
    expect(newGeneration.socket.sentBinary).toHaveLength(0);
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);
    expect(fanout.memberCount(roomChannelKey(ROOM_ID, 2))).toBe(1);
  });

  it("closes the sockets of a revoked member and of an ended room", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const sessions = createRelaySessionRegistry({ now: () => TEST_NOW_MS });
    const removed = setup({ fanout, sessions });
    const kept = setup({ fanout, sessions });
    removed.join({ clientName: "client-a", subject: "user-removed" });
    kept.join({ clientName: "client-b", subject: "user-kept" });

    expect(
      sessions.revokeMember(ROOM_CHANNEL, "user-removed", {
        revision: 2,
        nowSeconds: TEST_NOW_SECONDS,
      }),
    ).toBe(1);
    expect(removed.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.membershipRevoked,
    );
    expect(removed.connection.isJoined()).toBe(false);
    expect(kept.socket.closedWith).toBeUndefined();
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(1);

    expect(
      sessions.endChannel(ROOM_CHANNEL, {
        revision: 3,
        nowSeconds: TEST_NOW_SECONDS,
      }),
    ).toBe(1);
    expect(kept.socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.roomEnded);
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(0);
    expect(sessions.sessionCount()).toBe(0);
  });

  it("refuses a token that predates its own revocation", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const sessions = createRelaySessionRegistry({ now: () => TEST_NOW_MS });
    const removed = setup({ fanout, sessions });
    removed.join({ subject: "user-removed" });
    sessions.revokeMember(ROOM_CHANNEL, "user-removed", {
      revision: 2,
      nowSeconds: TEST_NOW_SECONDS,
    });

    // The member still holds a signed, unexpired token. Closing the socket is
    // not enough on its own: reconnecting with it must be refused too.
    const rejoin = setup({ fanout, sessions });
    rejoin.join({
      subject: "user-removed",
      token: issueJoinToken({
        roomId: ROOM_ID,
        clientId: clientIdSchema.parse("client-a"),
        subject: "user-removed",
        authRevision: 1,
      }),
    });
    expect(rejoin.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.membershipRevoked,
    );
    expect(rejoin.connection.isJoined()).toBe(false);
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(0);

    // Another member of the same room is unaffected by the cutoff.
    const other = setup({ fanout, sessions });
    other.join({ clientName: "client-b", subject: "user-kept" });
    expect(other.connection.isJoined()).toBe(true);
  });

  it("admits a re-granted member immediately with a newer token", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const sessions = createRelaySessionRegistry({ now: () => TEST_NOW_MS });
    const first = setup({ fanout, sessions });
    first.join({ subject: "user-guest" });
    sessions.revokeMember(ROOM_CHANNEL, "user-guest", {
      revision: 2,
      nowSeconds: TEST_NOW_SECONDS,
    });

    // Re-granting issues a token after the cutoff, so the cutoff must not
    // keep blocking the member for the rest of the token lifetime.
    const regranted = setup({ fanout, sessions });
    regranted.join({
      subject: "user-guest",
      token: issueJoinToken({
        roomId: ROOM_ID,
        clientId: clientIdSchema.parse("client-a"),
        subject: "user-guest",
        // Re-granting bumps the revision, so this token outranks the cutoff.
        authRevision: 3,
      }),
    });
    expect(regranted.socket.closedWith).toBeUndefined();
    expect(regranted.connection.isJoined()).toBe(true);

    // A replay of the earlier revocation cannot reach the newer session.
    expect(
      sessions.revokeMember(ROOM_CHANNEL, "user-guest", {
        revision: 2,
        nowSeconds: TEST_NOW_SECONDS,
      }),
    ).toBe(0);
    expect(regranted.connection.isJoined()).toBe(true);
  });

  it("drops revocation cutoffs once no token could still be covered", () => {
    let clockMs = TEST_NOW_MS;
    const sessions = createRelaySessionRegistry({ now: () => clockMs });
    // Cutoffs in rooms that never see traffic again must be retired too, so
    // the sweep cannot be limited to the channel being touched.
    for (let index = 0; index < 5; index += 1) {
      sessions.revokeMember(
        roomChannelKey(roomIdSchema.parse(`room-${index}`), 1),
        "user-removed",
        { revision: 2, nowSeconds: TEST_NOW_SECONDS },
      );
    }
    expect(sessions.cutoffCount()).toBe(5);

    // Past the longest possible join-token lifetime every cutoff is redundant.
    clockMs = TEST_NOW_MS + (MAX_JOIN_TOKEN_TTL_SECONDS + 60) * 1_000;
    expect(sessions.isRefused(ROOM_CHANNEL, "user-removed", 1)).toBe(false);
    expect(sessions.cutoffCount()).toBe(0);
  });

  it("closes a live session when the room expires", () => {
    const { socket, connection, join } = setup();
    join({ roomExpiresAtSeconds: TEST_NOW_SECONDS + 30 });
    expect(connection.isJoined()).toBe(true);

    vi.advanceTimersByTime(29_000);
    expect(socket.closedWith).toBeUndefined();
    vi.advanceTimersByTime(1_000);
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.roomEnded);
    expect(connection.isJoined()).toBe(false);
  });

  it("refuses a join for a room that has already expired", () => {
    const { socket, connection } = setup();
    connection.handleTextFrame(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: clientIdSchema.parse("client-a"),
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: clientIdSchema.parse("client-a"),
          roomExpiresAtSeconds: TEST_NOW_SECONDS - 1,
        }),
      }),
    );
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.roomEnded);
    expect(connection.isJoined()).toBe(false);
  });

  it("releases the session registry entry when a socket closes on its own", () => {
    const sessions = createRelaySessionRegistry({ now: () => TEST_NOW_MS });
    const { connection, join } = setup({ sessions });
    join({ subject: "user-a" });
    expect(sessions.sessionCount()).toBe(1);

    connection.handleSocketClosed();
    expect(sessions.sessionCount()).toBe(0);
    expect(
      sessions.revokeMember(ROOM_CHANNEL, "user-a", {
        revision: 2,
        nowSeconds: TEST_NOW_SECONDS,
      }),
    ).toBe(0);
  });
});

/**
 * Plan 19 step 2: the relay bounded every untrusted input by *size* but not by
 * *rate*, so a joined editor could send maximum-size frames as fast as it could
 * produce them (threat model T6). Budgets are the approved ones from
 * `docs/performance/collaboration-slo-capacity.md` §5.
 */
describe("relay connection rate budgets", () => {
  /** A clock the test advances by hand, so bucket refill is stated, not waited on. */
  const manualClock = (): {
    now: () => number;
    advance: (ms: number) => void;
  } => {
    let current = TEST_NOW_MS;
    return {
      now: () => current,
      advance: (ms) => {
        current += ms;
      },
    };
  };

  it("closes a connection that exceeds its scene frame budget", () => {
    const clock = manualClock();
    const { socket, connection, join } = setup({
      now: clock.now,
      limits: {
        rateLimits: {
          ...DEFAULT_LIMITS.rateLimits,
          sceneFramesPerSecond: 10,
          sceneFramesBurst: 3,
        },
      },
    });
    join();

    for (let frame = 0; frame < 3; frame += 1) {
      connection.handleBinaryFrame(sceneFrame());
      expect(socket.closedWith).toBeUndefined();
    }
    connection.handleBinaryFrame(sceneFrame());

    // Closed, not silently dropped: a dropped scene frame leaves a convergence
    // gap the sender cannot detect, while a close is repaired by recovery.
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.rateLimited);
    expect(connection.isJoined()).toBe(false);
  });

  it("refills the scene frame budget over time", () => {
    const clock = manualClock();
    const { socket, connection, join } = setup({
      now: clock.now,
      limits: {
        rateLimits: {
          ...DEFAULT_LIMITS.rateLimits,
          sceneFramesPerSecond: 10,
          sceneFramesBurst: 2,
        },
      },
    });
    join();

    connection.handleBinaryFrame(sceneFrame());
    connection.handleBinaryFrame(sceneFrame());
    // 10/s means one token per 100 ms.
    clock.advance(100);
    connection.handleBinaryFrame(sceneFrame());
    expect(socket.closedWith).toBeUndefined();

    connection.handleBinaryFrame(sceneFrame());
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.rateLimited);
  });

  it("bounds scene bytes independently of frame count", () => {
    const clock = manualClock();
    const { socket, connection, join } = setup({
      now: clock.now,
      limits: {
        rateLimits: {
          ...DEFAULT_LIMITS.rateLimits,
          sceneBytesPerSecond: 512,
          sceneBytesBurst: 512,
        },
      },
    });
    join();

    // Well inside the frame budget, over the byte budget: frame count alone is
    // not a bound, because 30 frames of 1 MiB is 30 MiB/s.
    connection.handleBinaryFrame(sceneFrame(400));
    expect(socket.closedWith).toBeUndefined();
    connection.handleBinaryFrame(sceneFrame(400));

    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.rateLimited);
  });

  it("keeps the presence budget separate from the scene budget", () => {
    const clock = manualClock();
    const { socket, connection, join } = setup({
      now: clock.now,
      limits: {
        rateLimits: {
          ...DEFAULT_LIMITS.rateLimits,
          sceneFramesPerSecond: 10,
          sceneFramesBurst: 1,
          presenceFramesPerSecond: 10,
          presenceFramesBurst: 4,
        },
      },
    });
    join();

    // Spending the scene budget must not spend the presence budget: the two
    // channels have different cadences and different consequences for loss.
    connection.handleBinaryFrame(sceneFrame());
    for (let frame = 0; frame < 4; frame += 1) {
      connection.handleBinaryFrame(presenceFrame());
      expect(socket.closedWith).toBeUndefined();
    }
    connection.handleBinaryFrame(presenceFrame());
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.rateLimited);
  });

  it("reports an oversize frame as a protocol violation, not a throttle", () => {
    const clock = manualClock();
    const { socket, connection, join } = setup({
      now: clock.now,
      limits: {
        rateLimits: {
          ...DEFAULT_LIMITS.rateLimits,
          sceneBytesPerSecond: 8,
          sceneBytesBurst: 8,
        },
      },
    });
    join();

    // The frame breaches both the size contract and the byte budget. The size
    // contract wins, because the two need opposite client behaviour: a protocol
    // violation is terminal, a throttle is retried.
    connection.handleBinaryFrame(
      sceneFrame(maxRelayDataFrameBytesFor("scene") + 1),
    );
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.protocolViolation);
  });
});

describe("relay connection idle budget", () => {
  it("closes a joined connection that never sends a frame", () => {
    // The injected clock advances with the fake timers: the idle deadline is a
    // timer plus a timestamp check (so an active connection costs no timer
    // churn), and the check is only meaningful if the two agree — which they do
    // in production, where both are real time.
    let current = TEST_NOW_MS;
    const advance = (ms: number): void => {
      current += ms;
      vi.advanceTimersByTime(ms);
    };
    const { socket, connection, join } = setup({
      now: () => current,
      limits: { idleTimeoutMs: 60_000 },
    });
    join();

    advance(59_999);
    expect(socket.closedWith).toBeUndefined();
    advance(1);

    // The heartbeat only proves the socket is alive; a forgotten tab answers
    // pings forever while holding a room slot.
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.idleTimeout);
    expect(connection.isJoined()).toBe(false);
  });

  it("keeps a connection that keeps sending frames", () => {
    let current = TEST_NOW_MS;
    const { socket, connection, join } = setup({
      now: () => current,
      limits: { idleTimeoutMs: 60_000 },
    });
    join();

    // A frame arriving inside the window must extend the deadline rather than
    // only postponing the check.
    for (let tick = 0; tick < 4; tick += 1) {
      current += 40_000;
      vi.advanceTimersByTime(40_000);
      connection.handleBinaryFrame(sceneFrame());
      expect(socket.closedWith).toBeUndefined();
    }

    current += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(socket.closedWith?.code).toBe(RELAY_CLOSE_CODES.idleTimeout);
  });

  it("leaves no idle timer behind after the socket closes", () => {
    const { connection, join } = setup({ limits: { idleTimeoutMs: 60_000 } });
    join();
    connection.handleSocketClosed();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("relay room and join-rate capacity", () => {
  it("refuses a join that would create a room beyond the room cap", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const first = setup({ fanout, limits: { maxRooms: 1 } });
    first.join({ clientName: "client-a" });
    expect(first.socket.closedWith).toBeUndefined();

    const second = setup({ fanout, limits: { maxRooms: 1 } });
    second.join({ clientName: "client-b", authGeneration: 2 });

    // Distinct from `relayAtCapacity` and `roomAtCapacity` so the disconnect
    // breakdown can tell "too many rooms" from "too many connections".
    expect(second.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.relayRoomsAtCapacity,
    );
  });

  it("still admits members of a room the relay already hosts", () => {
    const fanout = createInMemoryRoomFanout({ now: () => 1_000 });
    const first = setup({ fanout, limits: { maxRooms: 1 } });
    first.join({ clientName: "client-a" });

    // Joining an existing room adds no entry to the fanout's room map, so the
    // room cap must not refuse it — otherwise a full relay locks out the members
    // of the very rooms it is hosting.
    const second = setup({ fanout, limits: { maxRooms: 1 } });
    second.join({ clientName: "client-b" });

    expect(second.socket.closedWith).toBeUndefined();
    expect(fanout.memberCount(ROOM_CHANNEL)).toBe(2);
  });

  it("throttles repeated joins by the same subject across sockets", () => {
    const subjectRateLimiter = createSubjectRateLimiter({
      attemptsPerMinute: 60,
      burst: 2,
      now: () => TEST_NOW_MS,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const admitted = setup({ subjectRateLimiter });
      admitted.join({ subject: "user-a" });
      expect(admitted.socket.closedWith).toBeUndefined();
      admitted.connection.handleSocketClosed();
    }

    // `maxConnections` bounds how many sockets exist at once, not how fast one
    // subject churns through them — each churn costs a token verification and a
    // fanout mutation.
    const throttled = setup({ subjectRateLimiter });
    throttled.join({ subject: "user-a" });
    expect(throttled.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.rateLimited,
    );
    expect(throttled.connection.isJoined()).toBe(false);

    // A different subject is unaffected: the budget is per subject, not global.
    const other = setup({ subjectRateLimiter });
    other.join({ subject: "user-b", clientName: "client-b" });
    expect(other.socket.closedWith).toBeUndefined();
  });

  it("does not spend a subject's join budget on an unauthorized attempt", () => {
    const subjectRateLimiter = createSubjectRateLimiter({
      attemptsPerMinute: 60,
      burst: 1,
      now: () => TEST_NOW_MS,
    });
    const rejected = setup({ subjectRateLimiter });
    rejected.join({ subject: "user-a", token: "not-a-token" });
    expect(rejected.socket.closedWith?.code).toBe(
      RELAY_CLOSE_CODES.unauthorized,
    );

    // The budget is charged after authorization, so a flood of invalid tokens
    // cannot lock a legitimate member out of their own budget.
    const admitted = setup({ subjectRateLimiter });
    admitted.join({ subject: "user-a" });
    expect(admitted.socket.closedWith).toBeUndefined();
  });
});
