import { decodeBase64Url, encodeBase64Url } from "./base64.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
  type RoomId,
} from "./messages.ts";
import { DEFAULT_RELAY_RATE_LIMITS } from "./rate-limit.ts";
import {
  createRealtimeCryptoCodec,
  generateRoomKey,
} from "./realtime-crypto.ts";
import {
  decodeRelayDataFrame,
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
  DEFAULT_CONTROL_TOKEN_TTL_SECONDS,
  MAX_ROOM_TOKEN_BYTES,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomControlAction,
  type RoomRole,
} from "./room-auth.ts";
import {
  MAX_CONNECTIONS_PER_ROOM,
  ROOM_JOIN_TIMEOUT_MS,
} from "./room-limits.ts";
import {
  createRoomTokenId,
  signJoinToken,
  signRoomControlToken,
} from "./room-token.ts";

/**
 * Black-box wire-protocol conformance for the collaboration room runtime.
 *
 * The suite states the client-visible contract — join handshake, membership
 * notices, role enforcement, opaque binary fanout, close codes — in
 * transport-agnostic cases that a harness drives through its own connection
 * factory. It was written when two backends (the retired Node relay and the
 * Durable Object) had to prove the *same* contract; the Durable Object is now
 * the only backend, and runs the cases twice: inside workerd against the real
 * gateway + Object, and over the network against the deployed Worker
 * (`conformance-remote`). A contract break fails here before it can become a
 * client-visible difference.
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
 * `unsupportedProtocolVersion` (both an older and a newer declared version),
 * `membershipRevoked` (through the harness's
 * control capability, now that both backends dispatch control actions), plus
 * the normal `1000` leave. Three codes are deliberately *not* black-box cases
 * and stay covered by each backend's own deterministic tests asserting these
 * same shared constants:
 *
 * - `idleTimeout` (4010): needs 15 real minutes; both backends age their
 *   clock/attachment state instead.
 * - `slowConsumer` (4003): needs host-controlled outbound-buffer buildup,
 *   which neither `ws` nor workerd exposes to a black-box client.
 * - `internalError` (4014): triggering it requires injecting a server-side
 *   defect, by definition not reachable through the wire contract.
 *
 * One wire-contract property stays host-side on purpose: the control-frame
 * budget being counted in UTF-8 wire bytes rather than UTF-16 length is not
 * black-box distinguishable — an implementation counting either way refuses
 * the probe frame with the same `protocolViolation` (over the byte cap on the
 * correct path, as unparseable JSON on the wrong one).
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
   * the response to `RELAY_KEEPALIVE_REQUEST` is contractually optional, so
   * no case may depend on seeing or not seeing one.
   */
  next: (timeoutMs?: number) => Promise<ConformanceEvent>;
  /** Throws if any non-keepalive event arrives within `windowMs`. */
  expectSilence: (windowMs: number) => Promise<void>;
};

/**
 * Outcome of one control-token delivery. The two backends' HTTP responses
 * deliberately diverge (`{action, closed}` vs `{appliedRevision, closed}`,
 * lenient vs strict body schema, different paths), so the harness adapter owns
 * that surface and hands the cases only what the wire contract shares.
 */
export type ConformanceControlResult = {
  /** True when the backend verified the token and applied the action. */
  accepted: boolean;
  /** Sockets the backend reports closed; 0 when the token was refused. */
  closed: number;
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
  /**
   * Delivers one signed control token to the backend's control endpoint.
   * Returns `accepted: false` only for an authorization refusal (the
   * backend's 401); any transport or unexpected-status failure must throw.
   */
  control(token: string): Promise<ConformanceControlResult>;
};

export type ConformanceCase = {
  name: string;
  run(harness: ConformanceHarness): Promise<void>;
};

const DEFAULT_EVENT_TIMEOUT_MS = 3_000;
const SCENE_FLOOD_CLOSE_TIMEOUT_MS = 15_000;

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
    /** Room lifetime from now, when a case needs `rexp` to land mid-session. */
    roomExpiresInSeconds?: number;
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
          : Math.floor(Date.now() / 1000) +
            (overrides?.roomExpiresInSeconds ?? 3_600),
    },
    overrides?.secret ?? harness.secret,
  );
}

function issueControlToken(
  harness: ConformanceHarness,
  roomId: RoomId,
  options: {
    action: RoomControlAction;
    /** Member being revoked; required for `revoke-member`. */
    subject?: string;
    authGeneration?: number;
    /** Revision the change produced; defaults to 2 (one past a fresh room). */
    authRevision?: number;
    expired?: boolean;
    secret?: string;
  },
): string {
  const now =
    Math.floor(Date.now() / 1000) - (options.expired === true ? 3_600 : 0);
  const common = {
    v: ROOM_TOKEN_VERSION,
    jti: createRoomTokenId(),
    iat: now,
    exp: now + DEFAULT_CONTROL_TOKEN_TTL_SECONDS,
    aud: ROOM_TOKEN_AUDIENCES.control,
    rid: roomId,
    gen: options.authGeneration ?? 1,
    arev: options.authRevision ?? 2,
  } as const;
  return signRoomControlToken(
    options.action === "end-room"
      ? { ...common, action: "end-room" }
      : {
          ...common,
          action: "revoke-member",
          sub: options.subject ?? fail("revoke-member requires a subject"),
        },
    options.secret ?? harness.secret,
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
  timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
): Promise<void> {
  for (let events = 0; events < 8; events += 1) {
    const event = await connection.next(timeoutMs);
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

/**
 * Asserts no *data* frame reaches this connection within the window.
 * Membership notices are tolerated — cases that close another socket in the
 * same room legitimately produce a peers broadcast here — but a binary frame
 * or a close is a failure. The text-frame tolerance is what separates this
 * from `expectSilence`.
 */
async function expectNoBinaryWithin(
  connection: ConformanceConnection,
  windowMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    let event: ConformanceEvent;
    try {
      event = await connection.next(remaining);
    } catch {
      return; // Quiet until the deadline: exactly what the case asserts.
    }
    if (event.kind === "binary") {
      fail(`${label}: a data frame arrived (${event.bytes.byteLength} bytes)`);
    }
    if (event.kind === "close") {
      fail(`${label}: closed with ${event.code}`);
    }
  }
}

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
    // The web app can pick up a protocol bump before the relay does. That
    // client is not broken, so it must not get `protocolViolation` (terminal
    // for the client); it gets the same skew code as an outdated tab and
    // retries until the relay catches up.
    name: "a join from a newer protocol version closes with unsupportedProtocolVersion",
    async run(harness) {
      const roomId = uniqueRoomId("ahead");
      const connection = await harness.connect(roomId);
      connection.send(
        JSON.stringify({
          control: "join",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION + 1,
          roomId,
          token: issueToken(harness, roomId),
        }),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unsupportedProtocolVersion,
        "ahead protocol version",
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
      // *dropped* the join timeout fails here. The slack is wide on purpose:
      // the Durable Object reaps this socket from an alarm, and local
      // `wrangler dev` has been observed to deliver alarms a full check
      // interval (~10 s) late. Deadline *punctuality* is each backend's own
      // deterministic test (aged clocks/attachments); this case pins that the
      // reap happens at all and states the right code. It stays the slowest
      // case in the suite by design.
      const event = await connection.next(ROOM_JOIN_TIMEOUT_MS + 15_000);
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
  {
    name: "a join frame without a token closes with protocolViolation, not unauthorized",
    async run(harness) {
      // The missing field fails the control-frame schema before any token
      // verification runs; a backend that answered `unauthorized` here would
      // be reporting an authorization verdict it never reached.
      const roomId = uniqueRoomId("notoken");
      const connection = await harness.connect(roomId);
      connection.send(
        JSON.stringify({
          control: "join",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          roomId,
        }),
      );
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "join without token",
      );
    },
  },
  {
    name: "a token with a tampered payload closes with unauthorized",
    async run(harness) {
      const roomId = uniqueRoomId("tamper");
      const token = issueToken(harness, roomId, { role: "viewer" });
      const [payload, signature] = token.split(".");
      if (payload === undefined || signature === undefined) {
        fail("a signed token must have a payload and a signature segment");
      }
      const decoded = decodeBase64Url(payload, {
        maxBytes: MAX_ROOM_TOKEN_BYTES,
      });
      if (!decoded.ok) fail("token payload must decode");
      const claims = JSON.parse(
        new TextDecoder().decode(decoded.bytes),
      ) as Record<string, unknown>;
      // Privilege escalation attempt: rewrite the signed role, keep the
      // signature. Verification must fail on the signature, never trust the
      // rewritten claims.
      claims.role = "editor";
      const tampered = `${encodeBase64Url(
        new TextEncoder().encode(JSON.stringify(claims)),
      )}.${signature}`;
      const connection = await harness.connect(roomId);
      connection.send(joinFrame(roomId, tampered));
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unauthorized,
        "tampered token payload",
      );
    },
  },
  {
    name: "a syntactically valid join carrying a non-token string closes with unauthorized",
    async run(harness) {
      const roomId = uniqueRoomId("garbage");
      const connection = await harness.connect(roomId);
      connection.send(joinFrame(roomId, "garbage"));
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.unauthorized,
        "non-token join credential",
      );
    },
  },
  {
    name: "authorization generations of one room are disjoint channels",
    async run(harness) {
      const roomId = uniqueRoomId("gens");
      const genOne = await join(harness, roomId);
      const genTwo = await join(harness, roomId, { authGeneration: 2 });
      // Same roomId, different generation: a fresh channel with only itself.
      assertEqual(genTwo.joined.peers.length, 1, "gen-2 membership");
      // Membership isolation, checked from the other side too: a backend that
      // built gen 2's acknowledgment correctly but still broadcast the join
      // to gen 1 would pass the assertion above.
      await genOne.connection.expectSilence(250);
      genOne.connection.send(sceneFrame([42]));
      await genTwo.connection.expectSilence(250);
      genOne.connection.close();
      genTwo.connection.close();
    },
  },
  {
    name: "frames never cross rooms",
    async run(harness) {
      const roomA = uniqueRoomId("isoa");
      const roomB = uniqueRoomId("isob");
      const sender = await join(harness, roomA);
      const receiver = await join(harness, roomA, { role: "viewer" });
      const bystander = await join(harness, roomB);
      await expectPeersNotice(sender.connection);
      const frame = sceneFrame([9, 9]);
      sender.connection.send(frame);
      await expectBinary(receiver.connection, frame, "same-room receiver");
      await bystander.connection.expectSilence(250);
      sender.connection.close();
      receiver.connection.close();
      bystander.connection.close();
    },
  },
  {
    name: "a joiner's own membership arrives only in its ack, never as a self-broadcast",
    async run(harness) {
      // A backend that broadcast the peers notice to *all* members would
      // still pass the two-joiner case; only the joiner's silence right after
      // its ack pins the exclusion.
      const roomId = uniqueRoomId("noecho");
      const first = await join(harness, roomId);
      const second = await join(harness, roomId);
      await second.connection.expectSilence(250);
      const notice = await expectPeersNotice(first.connection);
      assertEqual(notice.peers.length, 2, "broadcast to existing members");
      first.connection.close();
      second.connection.close();
    },
  },
  {
    name: "a rejoining subject is assigned a fresh peerId",
    async run(harness) {
      const roomId = uniqueRoomId("fresh");
      const subject = `conf-${crypto.randomUUID().slice(0, 13)}`;
      const first = await join(harness, roomId, { subject });
      first.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(first.connection, 1000, "leave before rejoin");
      const second = await join(harness, roomId, { subject });
      if (second.joined.peerId === first.joined.peerId) {
        fail("a new session of the same subject must get a new peerId");
      }
      second.connection.close();
    },
  },
  {
    name: "fanout preserves order and duplicates — never deduped, reordered or coalesced",
    async run(harness) {
      const roomId = uniqueRoomId("order");
      const sender = await join(harness, roomId);
      const receiver = await join(harness, roomId, { role: "viewer" });
      await expectPeersNotice(sender.connection);
      const first = sceneFrame([1]);
      const second = sceneFrame([2]);
      sender.connection.send(first);
      sender.connection.send(second);
      sender.connection.send(first);
      await expectBinary(receiver.connection, first, "frame 1");
      await expectBinary(receiver.connection, second, "frame 2");
      await expectBinary(receiver.connection, first, "duplicated frame 3");
      sender.connection.close();
      receiver.connection.close();
    },
  },
  {
    name: "E2EE-sealed frames pass through byte-identical and still authenticate",
    async run(harness) {
      const roomId = uniqueRoomId("e2ee");
      const sender = await join(harness, roomId);
      const receiver = await join(harness, roomId, { role: "viewer" });
      await expectPeersNotice(sender.connection);
      // The room key exists only in this test process — the backend must
      // route the sealed bytes verbatim without being able to read them.
      const roomKey = generateRoomKey();
      const sealer = await createRealtimeCryptoCodec({
        roomKey,
        roomId,
        authGeneration: 1,
      });
      const opener = await createRealtimeCryptoCodec({
        roomKey,
        roomId,
        authGeneration: 1,
      });
      const plaintext = new TextEncoder().encode("conformance-e2ee");
      const sealed = await sealer.seal(plaintext, "scene");
      if (!sealed.ok) fail(`seal failed: ${sealed.error.code}`);
      const frame = encodeRelayDataFrame("scene", sealed.frame);
      sender.connection.send(frame);
      // Byte-identical transit: expectBinary compares every byte.
      await expectBinary(receiver.connection, frame, "sealed frame bytes");
      const decoded = decodeRelayDataFrame(frame);
      if (!decoded) fail("sealed frame must decode as a data frame");
      const openedFrame = await opener.open(decoded.payload, "scene");
      if (!openedFrame.ok) {
        fail(`sealed frame did not authenticate: ${openedFrame.error.code}`);
      }
      assertEqual(
        new TextDecoder().decode(openedFrame.plaintext),
        "conformance-e2ee",
        "opened plaintext",
      );
      sender.connection.close();
      receiver.connection.close();
    },
  },
  {
    name: "a scene flood beyond the published budget closes with rateLimited",
    async run(harness) {
      const roomId = uniqueRoomId("sflood");
      const { connection } = await join(harness, roomId);
      // Same 5x sizing rationale as the presence flood for real-network runs.
      // The local DO host freezes only its rate-limit clock so a constrained
      // workerd CI process cannot turn queued delivery time into token refill.
      const frames = DEFAULT_RELAY_RATE_LIMITS.sceneFramesBurst * 5;
      for (let index = 0; index < frames; index += 1) {
        connection.send(sceneFrame([index % 256]));
      }
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.rateLimited,
        "scene flood",
        SCENE_FLOOD_CLOSE_TIMEOUT_MS,
      );
    },
  },
  {
    name: "the scene byte budget binds independently of frame count",
    async run(harness) {
      const roomId = uniqueRoomId("sbytes");
      const { connection } = await join(harness, roomId);
      // 12 frames of ~1 MB ≈ 12 MB against the 8 MiB burst + 2 MiB/s refill.
      // Twelve frames are far below the frame-count budget, so only a
      // byte-charged bucket can produce this close.
      const payload = new Uint8Array(1_000_000);
      const frame = encodeRelayDataFrame("scene", payload);
      for (let index = 0; index < 12; index += 1) {
        connection.send(frame);
      }
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.rateLimited,
        "scene byte flood",
      );
    },
  },
  {
    name: "presence and scene budgets are charged separately",
    async run(harness) {
      const roomId = uniqueRoomId("buckets");
      const { connection } = await join(harness, roomId);
      // Spend most of each budget without exceeding either. A backend
      // charging both channels against one scene-sized bucket would cross it
      // (470 + 75 > 480) and close rateLimited instead of honouring the
      // leave below.
      const sceneSends = DEFAULT_RELAY_RATE_LIMITS.sceneFramesBurst - 10;
      const presenceSends = DEFAULT_RELAY_RATE_LIMITS.presenceFramesBurst - 5;
      for (let index = 0; index < sceneSends; index += 1) {
        connection.send(sceneFrame([index % 256]));
      }
      for (let index = 0; index < presenceSends; index += 1) {
        connection.send(presenceFrame([index % 256]));
      }
      connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(connection, 1000, "leave after spending both budgets");
    },
  },
  {
    name: "an oversize frame is a protocolViolation even when the send budget is spent",
    async run(harness) {
      const roomId = uniqueRoomId("prec");
      const { connection } = await join(harness, roomId);
      // Drain the presence burst completely, so a backend that consulted the
      // rate budget before the size bound would answer rateLimited here.
      for (
        let index = 0;
        index < DEFAULT_RELAY_RATE_LIMITS.presenceFramesBurst;
        index += 1
      ) {
        connection.send(presenceFrame([index % 256]));
      }
      const oversize = new Uint8Array(
        maxRelayDataFrameBytesFor("presence") + 1,
      );
      oversize[0] = 0x02;
      connection.send(oversize);
      await expectClose(
        connection,
        RELAY_CLOSE_CODES.protocolViolation,
        "oversize frame with an empty budget",
      );
    },
  },
  {
    name: "a live session closes with roomEnded when the room lifetime ends mid-session",
    async run(harness) {
      // The existing roomEnded case covers a join into an already-expired
      // room; this one pins the *push* side — the server must end a session
      // that was legal when it started.
      const roomId = uniqueRoomId("midexp");
      const { connection } = await join(harness, roomId, {
        roomExpiresInSeconds: 3,
      });
      const event = await connection.next(15_000);
      if (event.kind !== "close") {
        fail(`Expected the room-expiry close, received ${event.kind}`);
      }
      assertEqual(
        event.code,
        RELAY_CLOSE_CODES.roomEnded,
        "mid-session expiry close code",
      );
    },
  },
  {
    name: "a refused viewer scene frame is never delivered to the room",
    async run(harness) {
      const roomId = uniqueRoomId("norelay");
      const editor = await join(harness, roomId);
      const viewer = await join(harness, roomId, { role: "viewer" });
      await expectPeersNotice(editor.connection);
      viewer.connection.send(sceneFrame([5]));
      await expectClose(
        viewer.connection,
        RELAY_CLOSE_CODES.readOnlyRole,
        "viewer scene publish",
      );
      // The editor sees the membership change, but the refused frame's bytes
      // must never fan out.
      await expectNoBinaryWithin(
        editor.connection,
        300,
        "refused frame fanout",
      );
      editor.connection.close();
    },
  },
  {
    name: "a joined socket outlives the join deadline",
    async run(harness) {
      // The deadline case proves the timer fires; this proves it is
      // *cancelled* by a successful join — a backend that kept the timer
      // armed would close this socket at the 10 s mark.
      const roomId = uniqueRoomId("alive");
      const { connection } = await join(harness, roomId);
      await connection.expectSilence(ROOM_JOIN_TIMEOUT_MS + 2_000);
      connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(connection, 1000, "leave after the deadline window");
    },
  },
  {
    name: "revoke-member closes exactly that member with membershipRevoked",
    async run(harness) {
      const roomId = uniqueRoomId("revoke");
      const revokedSubject = `conf-${crypto.randomUUID().slice(0, 13)}`;
      const staying = await join(harness, roomId);
      const revoked = await join(harness, roomId, {
        subject: revokedSubject,
      });
      await expectPeersNotice(staying.connection);
      const result = await harness.control(
        issueControlToken(harness, roomId, {
          action: "revoke-member",
          subject: revokedSubject,
        }),
      );
      assertEqual(result.accepted, true, "revocation accepted");
      assertEqual(result.closed, 1, "revocation closed sessions");
      await expectClose(
        revoked.connection,
        RELAY_CLOSE_CODES.membershipRevoked,
        "revoked member",
      );
      const notice = await expectPeersNotice(staying.connection);
      assertEqual(notice.peers.length, 1, "peers after revocation");
      assertEqual(
        notice.peers[0]?.peerId,
        staying.joined.peerId,
        "surviving peer",
      );
      staying.connection.close();
    },
  },
  {
    name: "end-room closes every session in the generation with roomEnded",
    async run(harness) {
      const roomId = uniqueRoomId("end");
      const first = await join(harness, roomId);
      const second = await join(harness, roomId, { role: "viewer" });
      await expectPeersNotice(first.connection);
      const result = await harness.control(
        issueControlToken(harness, roomId, { action: "end-room" }),
      );
      assertEqual(result.accepted, true, "end-room accepted");
      assertEqual(result.closed, 2, "end-room closed sessions");
      await expectClose(
        first.connection,
        RELAY_CLOSE_CODES.roomEnded,
        "first member",
      );
      await expectClose(
        second.connection,
        RELAY_CLOSE_CODES.roomEnded,
        "second member",
      );
    },
  },
  {
    name: "a rejoin replaying a pre-revocation token is refused with membershipRevoked",
    async run(harness) {
      const roomId = uniqueRoomId("replay");
      const subject = `conf-${crypto.randomUUID().slice(0, 13)}`;
      const token = issueToken(harness, roomId, { subject });
      const first = await harness.connect(roomId);
      first.send(joinFrame(roomId, token));
      await expectJoined(first);
      const result = await harness.control(
        issueControlToken(harness, roomId, {
          action: "revoke-member",
          subject,
        }),
      );
      assertEqual(result.accepted, true, "revocation accepted");
      await expectClose(
        first,
        RELAY_CLOSE_CODES.membershipRevoked,
        "live session",
      );
      // The token is still unexpired; only the durable cutoff can refuse it.
      const replay = await harness.connect(roomId);
      replay.send(joinFrame(roomId, token));
      await expectClose(
        replay,
        RELAY_CLOSE_CODES.membershipRevoked,
        "replayed pre-revocation token",
      );
    },
  },
  {
    name: "a re-granted member joins past the cutoff and a replayed revocation is a no-op",
    async run(harness) {
      const roomId = uniqueRoomId("regrant");
      const subject = `conf-${crypto.randomUUID().slice(0, 13)}`;
      const revocation = issueControlToken(harness, roomId, {
        action: "revoke-member",
        subject,
        authRevision: 2,
      });
      // Control-first: the revocation lands before any session exists.
      const first = await harness.control(revocation);
      assertEqual(first.accepted, true, "control against an empty room");
      assertEqual(first.closed, 0, "nothing to close yet");
      const regranted = await join(harness, roomId, {
        subject,
        authRevision: 3,
      });
      // Replaying the identical older control must not reach the session a
      // newer revision authorized.
      const replay = await harness.control(revocation);
      assertEqual(replay.accepted, true, "replay accepted idempotently");
      assertEqual(replay.closed, 0, "replay closed nothing");
      regranted.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(regranted.connection, 1000, "re-granted member stays");
    },
  },
  {
    name: "control actions are scoped to their authorization generation",
    async run(harness) {
      const roomId = uniqueRoomId("genscope");
      const genOne = await join(harness, roomId);
      const genTwo = await join(harness, roomId, { authGeneration: 2 });
      const result = await harness.control(
        issueControlToken(harness, roomId, {
          action: "end-room",
          authGeneration: 1,
        }),
      );
      assertEqual(result.accepted, true, "gen-1 end accepted");
      assertEqual(result.closed, 1, "only the gen-1 session closed");
      await expectClose(
        genOne.connection,
        RELAY_CLOSE_CODES.roomEnded,
        "gen-1 member",
      );
      await genTwo.connection.expectSilence(250);
      genTwo.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(genTwo.connection, 1000, "gen-2 member unaffected");
    },
  },
  {
    name: "an invalid control token is refused and touches no session",
    async run(harness) {
      const roomId = uniqueRoomId("badctl");
      const member = await join(harness, roomId);
      const forged = await harness.control(
        issueControlToken(harness, roomId, {
          action: "end-room",
          secret: "conformance-forged-secret-0123456789abcdef",
        }),
      );
      assertEqual(forged.accepted, false, "forged control token");
      assertEqual(forged.closed, 0, "forged token closed nothing");
      const expired = await harness.control(
        issueControlToken(harness, roomId, {
          action: "end-room",
          expired: true,
        }),
      );
      assertEqual(expired.accepted, false, "expired control token");
      // A join token on the control endpoint is a wrong-audience refusal.
      const joinAudience = await harness.control(issueToken(harness, roomId));
      assertEqual(joinAudience.accepted, false, "join token on control");
      member.connection.send(encodeRelayControl({ control: "leave" }));
      await expectClose(member.connection, 1000, "member untouched");
    },
  },
];
