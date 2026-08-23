import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
  type RoomId,
} from "./messages.ts";
import {
  encodeRelayControl,
  encodeRelayDataFrame,
  maxRelayDataFrameBytesFor,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  parseRelayServerControl,
  RELAY_CLOSE_CODES,
  RELAY_KEEPALIVE_REQUEST,
  RELAY_KEEPALIVE_RESPONSE,
  type RelayJoinedNotice,
  type RelayPeersNotice,
} from "./relay-protocol.ts";
import {
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomRole,
} from "./room-auth.ts";
import {
  MAX_CONNECTIONS_PER_ROOM,
  ROOM_JOIN_TIMEOUT_MS,
} from "./room-limits.ts";
import { createRoomTokenId, signJoinToken } from "./room-token.ts";

/**
 * Black-box wire-protocol conformance shared by the Node relay and the
 * Durable Object room runtime.
 *
 * Both backends promise the *same* client-visible contract — join handshake,
 * membership notices, role enforcement, opaque binary fanout, close codes —
 * and the client is explicitly forbidden from detecting which backend it is
 * talking to. The only way that stays true is a single suite of cases that
 * every backend's test run drives through its own transport: the relay runs
 * them against a live `ws` server, the Durable Object runs them inside
 * workerd against the real gateway + Object. A parity break fails here before
 * it can become a client-visible difference.
 *
 * Test-only module: imported exclusively from test files (it signs real
 * tokens via the server-only `./room-token.ts`), never from runtime code.
 *
 * Cases use plain thrown `Error`s instead of a test framework so the module
 * stays runnable under both vitest environments (Node and workerd) without
 * importing either.
 *
 * Close-code coverage. Every shared close code that a black-box client can
 * deterministically trigger is exercised here: `protocolViolation`,
 * `roomAtCapacity`, `joinTimeout` (a real wait against the published 10 s
 * deadline), `unauthorized`, `readOnlyRole`, `roomEnded`, `rateLimited`,
 * `unsupportedProtocolVersion`, plus the normal `1000` leave. Four codes are
 * deliberately *not* black-box cases and stay covered by each backend's own
 * deterministic tests asserting these same shared constants:
 *
 * - `idleTimeout` (4010): needs 15 real minutes; both backends age their
 *   clock/attachment state instead.
 * - `slowConsumer` (4003): needs host-controlled outbound-buffer buildup,
 *   which neither `ws` nor workerd exposes to a black-box client.
 * - `membershipRevoked` (4007): the black-box trigger is a control-plane
 *   revocation, which the Durable Object gateway only dispatches from
 *   Plan 11 on — promote it to a shared case then.
 * - `internalError` (4014): triggering it requires injecting a server-side
 *   defect, by definition not reachable through the wire contract.
 */

export type ConformanceEvent =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array }
  | { kind: "close"; code: number; reason: string };

export type ConformanceConnection = {
  send: (data: string | Uint8Array) => void;
  /** Client-initiated close, no status. Safe to call twice. */
  close: () => void;
  /**
   * Next delivered event. Keepalive acknowledgments are filtered out here:
   * the Durable Object answers `RELAY_KEEPALIVE_REQUEST` and the Node relay
   * does not, and that asymmetry is contractual (the response is optional),
   * so no case may depend on seeing or not seeing one.
   */
  next: (timeoutMs?: number) => Promise<ConformanceEvent>;
  /** Throws if any non-keepalive event arrives within `windowMs`. */
  expectSilence: (windowMs: number) => Promise<void>;
};

export type ConformanceHarness = {
  /** Secret the backend verifies join tokens with. */
  readonly secret: string;
  /**
   * One raw client socket, already open, addressed to the room. The relay
   * ignores the addressing (its routing comes from the token alone); the
   * Durable Object gateway routes on it.
   */
  connect(
    roomId: RoomId,
    authGeneration?: number,
  ): Promise<ConformanceConnection>;
};

export type ConformanceCase = {
  name: string;
  run(harness: ConformanceHarness): Promise<void>;
};

const DEFAULT_EVENT_TIMEOUT_MS = 3_000;

/**
 * Wraps a raw wire (send/close) into a `ConformanceConnection` with a queued,
 * awaitable event stream. Harnesses feed events in via `push`; the queue
 * decouples the backends' differing callback styles from the cases.
 */
export function createConformanceConnection(wire: {
  send: (data: string | Uint8Array) => void;
  close: () => void;
}): {
  connection: ConformanceConnection;
  push: (event: ConformanceEvent) => void;
} {
  const queued: ConformanceEvent[] = [];
  const waiters: ((event: ConformanceEvent) => void)[] = [];

  const push = (event: ConformanceEvent): void => {
    if (event.kind === "text" && event.text === RELAY_KEEPALIVE_RESPONSE) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    queued.push(event);
  };

  const next = (
    timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
  ): Promise<ConformanceEvent> => {
    const immediate = queued.shift();
    if (immediate) return Promise.resolve(immediate);
    return new Promise<ConformanceEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(settle);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`No event within ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = (event: ConformanceEvent): void => {
        clearTimeout(timer);
        resolve(event);
      };
      waiters.push(settle);
    });
  };

  return {
    connection: {
      send: (data) => wire.send(data),
      close: () => wire.close(),
      next,
      async expectSilence(windowMs) {
        try {
          const event = await next(windowMs);
          throw new Error(
            `Expected silence for ${windowMs} ms, received ${JSON.stringify(event.kind === "binary" ? { kind: "binary", byteLength: event.bytes.byteLength } : event)}`,
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("No event")) {
            return;
          }
          throw error;
        }
      },
    },
    push,
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Unique per invocation so cases never share room (or Object) state. */
function uniqueRoomId(label: string): RoomId {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return roomIdSchema.parse(`conf-${label}-${suffix}`);
}

function issueToken(
  harness: ConformanceHarness,
  roomId: RoomId,
  overrides?: {
    role?: RoomRole;
    subject?: string;
    authGeneration?: number;
    authRevision?: number;
    expired?: boolean;
    roomExpired?: boolean;
    secret?: string;
    /** Room id the claims carry, when it must differ from the join's. */
    claimedRoomId?: RoomId;
  },
): string {
  const now =
    Math.floor(Date.now() / 1000) - (overrides?.expired === true ? 3_600 : 0);
  return signJoinToken(
    {
      v: ROOM_TOKEN_VERSION,
      jti: createRoomTokenId(),
      iat: now,
      exp: now + 60,
      aud: ROOM_TOKEN_AUDIENCES.join,
      rid: overrides?.claimedRoomId ?? roomId,
      gen: overrides?.authGeneration ?? 1,
      // Unique by default: the relay budgets join attempts per subject
      // across the whole process, so a shared default subject would trip
      // that (relay-specific) limiter from inside a suite about the shared
      // wire contract.
      sub: overrides?.subject ?? `conf-${crypto.randomUUID().slice(0, 13)}`,
      role: overrides?.role ?? "editor",
      arev: overrides?.authRevision ?? 1,
      rexp:
        overrides?.roomExpired === true
          ? Math.floor(Date.now() / 1000) - 10
          : Math.floor(Date.now() / 1000) + 3_600,
    },
    overrides?.secret ?? harness.secret,
  );
}

function joinFrame(roomId: RoomId, token: string): string {
  return encodeRelayControl({
    control: "join",
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    roomId,
    token,
  });
}

async function nextServerControl(
  connection: ConformanceConnection,
): Promise<RelayJoinedNotice | RelayPeersNotice> {
  const event = await connection.next();
  if (event.kind !== "text") {
    fail(`Expected a control frame, received ${event.kind}`);
  }
  const control = parseRelayServerControl(event.text);
  if (!control) fail(`Unparseable server control frame: ${event.text}`);
  return control;
}

async function expectJoined(
  connection: ConformanceConnection,
): Promise<RelayJoinedNotice> {
  const control = await nextServerControl(connection);
  if (control.control !== "joined") {
    fail(`Expected a joined acknowledgment, received ${control.control}`);
  }
  return control;
}

async function expectPeersNotice(
  connection: ConformanceConnection,
): Promise<RelayPeersNotice> {
  const control = await nextServerControl(connection);
  if (control.control !== "peers") {
    fail(`Expected a peers notice, received ${control.control}`);
  }
  return control;
}

/** Reads events until the close, tolerating late membership notices. */
async function expectClose(
  connection: ConformanceConnection,
  expectedCode: number,
  label: string,
): Promise<void> {
  for (let events = 0; events < 8; events += 1) {
    const event = await connection.next();
    if (event.kind === "close") {
      assertEqual(event.code, expectedCode, `${label}: close code`);
      return;
    }
  }
  fail(`${label}: no close event arrived`);
}

async function join(
  harness: ConformanceHarness,
  roomId: RoomId,
  overrides?: Parameters<typeof issueToken>[2],
): Promise<{ connection: ConformanceConnection; joined: RelayJoinedNotice }> {
  const connection = await harness.connect(
    roomId,
    overrides?.authGeneration ?? 1,
  );
  connection.send(joinFrame(roomId, issueToken(harness, roomId, overrides)));
  const joined = await expectJoined(connection);
  return { connection, joined };
}

async function expectBinary(
  connection: ConformanceConnection,
  expected: Uint8Array,
  label: string,
): Promise<void> {
  for (let events = 0; events < 8; events += 1) {
    const event = await connection.next();
    if (event.kind === "binary") {
      assertEqual(
        event.bytes.byteLength,
        expected.byteLength,
        `${label}: byteLength`,
      );
      for (let index = 0; index < expected.byteLength; index += 1) {
        if (event.bytes[index] !== expected[index]) {
          fail(`${label}: byte ${index} differs`);
        }
      }
      return;
    }
    // Membership notices may interleave with fanout; only binary is asserted.
    if (event.kind === "close") fail(`${label}: closed with ${event.code}`);
  }
  fail(`${label}: no binary frame arrived`);
}

const presenceFrame = (bytes: number[]): Uint8Array =>
  encodeRelayDataFrame("presence", Uint8Array.from(bytes));
const sceneFrame = (bytes: number[]): Uint8Array =>
  encodeRelayDataFrame("scene", Uint8Array.from(bytes));

export const relayProtocolConformanceCases: readonly ConformanceCase[] = [
  {
    name: "join acknowledges with server-assigned identity, echoed role and self in peers",
    async run(harness) {
      const roomId = uniqueRoomId("ack");
      const { connection, joined } = await join(harness, roomId, {
        role: "viewer",
      });
      assertEqual(joined.roomId, roomId, "roomId");
      assertEqual(joined.role, "viewer", "echoed role");
      assertEqual(
        joined.protocolVersion,
        COLLABORATION_PROTOCOL_VERSION,
        "protocolVersion",
      );
      if (joined.roomGeneration < 1) fail("roomGeneration must be positive");
      assertEqual(joined.peers.length, 1, "peers length");
      assertEqual(joined.peers[0]?.peerId, joined.peerId, "self peer id");
      assertEqual(joined.peers[0]?.role, "viewer", "self peer role");
      connection.close();
    },
  },
  {
    name: "a second joiner appears in both its ack and the peers broadcast",
    async run(harness) {
      const roomId = uniqueRoomId("peers");
      const first = await join(harness, roomId);
      const second = await join(harness, roomId, { role: "viewer" });
      assertEqual(second.joined.peers.length, 2, "second ack peers length");
      const notice = await expectPeersNotice(first.connection);
      assertEqual(notice.peers.length, 2, "broadcast peers length");
      const joinerEntry = notice.peers.find(
        (peer) => peer.peerId === second.joined.peerId,
      );
      assertEqual(joinerEntry?.role, "viewer", "joiner role in broadcast");
      assertEqual(
        second.joined.roomGeneration,
        first.joined.roomGeneration,
        "shared room generation",
      );
      first.connection.close();
      second.connection.close();
    },
  },
  {
    name: "scene frames fan out to other members verbatim, never back to the sender",
    async run(harness) {
      const roomId = uniqueRoomId("scene");
      const sender = await join(harness, roomId);
      const receiver = await join(harness, roomId, { role: "viewer" });
      await expectPeersNotice(sender.connection);
      const frame = sceneFrame([7, 8, 9, 10]);
      sender.connection.send(frame);
      await expectBinary(receiver.connection, frame, "receiver scene frame");
      await sender.connection.expectSilence(200);
      sender.connection.close();
      receiver.connection.close();
    },
  },
  {
    name: "presence frames fan out on the presence channel",
    async run(harness) {
      const roomId = uniqueRoomId("presence");
      const sender = await join(harness, roomId, { role: "viewer" });
      const receiver = await join(harness, roomId);
      await expectPeersNotice(sender.connection);
      const frame = presenceFrame([1, 2, 3]);
      sender.connection.send(frame);
      await expectBinary(receiver.connection, frame, "receiver presence frame");
      sender.connection.close();
      receiver.connection.close();
    },
  },
  {
    name: "a viewer scene publish closes with readOnlyRole",
    async run(harness) {
      const roomId = uniqueRoomId("viewer");
      const viewer = await join(harness, roomId, { role: "viewer" });
      viewer.connection.send(sceneFrame([1]));
      await expectClose(
        viewer.connection,
        RELAY_CLOSE_CODES.readOnlyRole,
        "viewer scene publish",
      );
    },
  },
  {
    name: "a malformed control frame closes with protocolViolation",
    async run(harness) {
      const connection = await harness.connect(uniqueRoomId("malformed"));
      connection.send("this is not a control frame");
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "malformed control",
      );
    },
  },
  {
    name: "a binary frame before join closes with protocolViolation",
    async run(harness) {
      const connection = await harness.connect(uniqueRoomId("early"));
      connection.send(presenceFrame([1, 2]));
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "binary before join",
      );
    },
  },
  {
    name: "a second join closes with protocolViolation",
    async run(harness) {
      const roomId = uniqueRoomId("rejoin");
      const { connection } = await join(harness, roomId);
      connection.send(joinFrame(roomId, issueToken(harness, roomId)));
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "second join",
      );
    },
  },
  {
    name: "an oversize control frame closes with protocolViolation",
    async run(harness) {
      const connection = await harness.connect(uniqueRoomId("oversizec"));
      connection.send("x".repeat(MAX_RELAY_CONTROL_FRAME_BYTES + 1));
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "oversize control",
      );
    },
  },
  {
    name: "an unknown data channel byte closes with protocolViolation",
    async run(harness) {
      const roomId = uniqueRoomId("channel");
      const { connection } = await join(harness, roomId);
      connection.send(Uint8Array.from([0x7f, 1, 2, 3]));
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "unknown channel byte",
      );
    },
  },
  {
    name: "an oversize presence frame closes with protocolViolation",
    async run(harness) {
      const roomId = uniqueRoomId("oversizep");
      const { connection } = await join(harness, roomId);
      const oversize = new Uint8Array(
        maxRelayDataFrameBytesFor("presence") + 1,
      );
      oversize[0] = 0x02;
      connection.send(oversize);
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "oversize presence frame",
      );
    },
  },
  {
    name: "a token signed with another secret closes with unauthorized",
    async run(harness) {
      const roomId = uniqueRoomId("forged");
      const connection = await harness.connect(roomId);
      connection.send(
        joinFrame(
          roomId,
          issueToken(harness, roomId, {
            secret: "conformance-forged-secret-0123456789abcdef",
          }),
        ),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unauthorized,
        "forged token",
      );
    },
  },
  {
    name: "an expired token closes with unauthorized",
    async run(harness) {
      const roomId = uniqueRoomId("expired");
      const connection = await harness.connect(roomId);
      connection.send(
        joinFrame(roomId, issueToken(harness, roomId, { expired: true })),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unauthorized,
        "expired token",
      );
    },
  },
  {
    name: "a token bound to another room closes with unauthorized",
    async run(harness) {
      const roomId = uniqueRoomId("wrongroom");
      const connection = await harness.connect(roomId);
      connection.send(
        joinFrame(
          roomId,
          issueToken(harness, roomId, {
            claimedRoomId: uniqueRoomId("other"),
          }),
        ),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unauthorized,
        "wrong-room token",
      );
    },
  },
  {
    name: "a join from an older protocol version closes with unsupportedProtocolVersion",
    async run(harness) {
      const roomId = uniqueRoomId("stale");
      const connection = await harness.connect(roomId);
      connection.send(
        JSON.stringify({
          control: "join",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION - 1,
          roomId,
          token: issueToken(harness, roomId),
        }),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unsupportedProtocolVersion,
        "stale protocol version",
      );
    },
  },
  {
    name: "a token whose room lifetime has ended closes with roomEnded",
    async run(harness) {
      const roomId = uniqueRoomId("roomexp");
      const connection = await harness.connect(roomId);
      connection.send(
        joinFrame(roomId, issueToken(harness, roomId, { roomExpired: true })),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.roomEnded,
        "expired room",
      );
    },
  },
  {
    name: "leave closes normally and shrinks the peers broadcast",
    async run(harness) {
      const roomId = uniqueRoomId("leave");
      const staying = await join(harness, roomId);
      const leaving = await join(harness, roomId);
      await expectPeersNotice(staying.connection);
      leaving.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(leaving.connection, 1000, "leave");
      const notice = await expectPeersNotice(staying.connection);
      assertEqual(notice.peers.length, 1, "peers after leave");
      assertEqual(
        notice.peers[0]?.peerId,
        staying.joined.peerId,
        "remaining peer",
      );
      staying.connection.close();
    },
  },
  {
    name: "a disconnect without leave shrinks the peers broadcast",
    async run(harness) {
      const roomId = uniqueRoomId("drop");
      const staying = await join(harness, roomId);
      const dropping = await join(harness, roomId);
      await expectPeersNotice(staying.connection);
      dropping.connection.close();
      const notice = await expectPeersNotice(staying.connection);
      assertEqual(notice.peers.length, 1, "peers after disconnect");
      staying.connection.close();
    },
  },
  {
    name: "the keepalive frame is tolerated before and after join",
    async run(harness) {
      const roomId = uniqueRoomId("keepalive");
      const connection = await harness.connect(roomId);
      connection.send(RELAY_KEEPALIVE_REQUEST);
      await connection.expectSilence(200);
      connection.send(joinFrame(roomId, issueToken(harness, roomId)));
      await expectJoined(connection);
      connection.send(RELAY_KEEPALIVE_REQUEST);
      await connection.expectSilence(200);
      connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(connection, 1000, "leave after keepalive");
    },
  },
  {
    name: "a presence flood beyond the published budget closes with rateLimited",
    async run(harness) {
      const roomId = uniqueRoomId("flood");
      const { connection } = await join(harness, roomId);
      // The presence budget admits an 80-frame burst and refills at 40/s.
      // Sized so the verdict cannot depend on scheduling: even if a loaded
      // test host smears these sends across several seconds of server-side
      // arrival time, the refill (40 per second smeared) cannot keep pace
      // with 400 frames.
      for (let index = 0; index < 400; index += 1) {
        connection.send(presenceFrame([index % 256]));
      }
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.rateLimited,
        "presence flood",
      );
    },
  },
  {
    name: "a join beyond the room member cap closes with roomAtCapacity",
    async run(harness) {
      const roomId = uniqueRoomId("cap");
      const members: Awaited<ReturnType<typeof join>>[] = [];
      for (let index = 0; index < MAX_CONNECTIONS_PER_ROOM; index += 1) {
        members.push(await join(harness, roomId));
      }
      const refused = await harness.connect(roomId);
      refused.send(joinFrame(roomId, issueToken(harness, roomId)));
      // Membership notices from the join storm may be queued ahead of the
      // refusal on this socket too; expectClose tolerates them.
      await expectClose(
        refused,
        RELAY_CLOSE_CODES.roomAtCapacity,
        "join past the member cap",
      );
      for (const member of members) member.connection.close();
    },
  },
  {
    name: "a socket that never joins is closed at the join deadline with joinTimeout",
    async run(harness) {
      const connection = await harness.connect(uniqueRoomId("jointo"));
      // A real wait against the published deadline, so a backend that quietly
      // stretched or dropped the join timeout fails here. Generous slack for
      // scheduling; the case stays the slowest in the suite by design.
      const event = await connection.next(ROOM_JOIN_TIMEOUT_MS + 5_000);
      if (event.kind !== "close") {
        fail(`Expected the join-deadline close, received ${event.kind}`);
      }
      assertEqual(
        event.code,
        RELAY_CLOSE_CODES.joinTimeout,
        "join deadline close code",
      );
    },
  },
  {
    name: "room generation is shared within a cohort and strictly increases across cohorts",
    async run(harness) {
      const roomId = uniqueRoomId("epoch");
      const first = await join(harness, roomId);
      const second = await join(harness, roomId);
      assertEqual(
        second.joined.roomGeneration,
        first.joined.roomGeneration,
        "cohort generation",
      );
      first.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(first.connection, 1000, "first leave");
      second.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(second.connection, 1000, "second leave");
      // Both backends settle membership on the close event; give the server
      // side a beat so the rejoin below starts a genuinely new cohort.
      await sleep(150);
      const rejoined = await join(harness, roomId);
      if (rejoined.joined.roomGeneration <= first.joined.roomGeneration) {
        fail(
          `rejoin generation ${rejoined.joined.roomGeneration} must exceed ${first.joined.roomGeneration}`,
        );
      }
      rejoined.connection.close();
    },
  },
];
