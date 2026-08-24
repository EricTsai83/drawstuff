#!/usr/bin/env node
/**
 * Live smoke for a deployed collaboration DO gateway.
 *
 * Two layers:
 *
 * 1. Closed-response HTTP checks (Plan 09 evidence): healthz readiness,
 *    unknown-route/method/content-type/body handling. Always run.
 * 2. WebSocket room-runtime smoke (Plan 10 evidence): two real clients join a
 *    fresh room through the deployed Worker, exchange E2EE-sealed scene and
 *    presence frames end to end (the room key never leaves this process), and
 *    verify the keepalive auto-response, then end the room over the control
 *    endpoint and prove a pre-end token is refused (Plan 11 evidence: the
 *    Vercel-like HTTP caller → Worker → typed RPC → DO path). Runs only when
 *    `COLLAB_JOIN_TOKEN_SECRET` is provided, because the smoke must sign real
 *    join and control tokens with the deployed Worker's secret.
 *
 * The full contract matrix (Origin allowlist, header stripping, DO identity,
 * close codes, limits) is owned by the workerd test suite; this script proves
 * the *deployed* Worker answers with the same surface, during the 0%-traffic
 * window, and prints the version id for the deploy record.
 *
 * Usage:
 *   pnpm --filter @drawstuff/collaboration-do smoke <base-url>
 *   COLLAB_JOIN_TOKEN_SECRET=... pnpm --filter @drawstuff/collaboration-do smoke <base-url>
 */

import { WebSocket } from "ws";

import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import { createConformanceConnection } from "@drawstuff/collaboration/protocol-conformance";
import {
  createRealtimeCryptoCodec,
  generateRoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayServerControl,
  RELAY_CLOSE_CODES,
  RELAY_KEEPALIVE_REQUEST,
  RELAY_KEEPALIVE_RESPONSE,
} from "@drawstuff/collaboration/relay-protocol";
import {
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signJoinToken,
  signRoomControlToken,
} from "@drawstuff/collaboration/room-token";

const base = process.argv[2];
if (!base) {
  console.error("usage: pnpm smoke <base-url>");
  process.exit(2);
}
const target = base.replace(/\/+$/, "");

/** Must be on the deployed Worker's COLLAB_ALLOWED_ORIGINS allowlist. */
const SMOKE_ORIGIN = process.env.COLLAB_SMOKE_ORIGIN ?? "http://localhost:3000";

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}: ${error.message}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

await check("healthz is ok and reports version metadata", async () => {
  const response = await fetch(`${target}/healthz`);
  expect(response.status === 200, `status ${response.status}`);
  const body = await response.json();
  console.log(
    `      version=${body?.version?.id ?? "?"} ready=${JSON.stringify(body?.ready)}`,
  );
  expect(
    body.ok === true,
    `ok=${String(body.ok)} — secret or origin allowlist not ready`,
  );
});

await check("unknown route closes with 404", async () => {
  const response = await fetch(`${target}/metrics`);
  expect(response.status === 404, `status ${response.status}`);
});

await check("socket route without Upgrade closes with 426", async () => {
  const response = await fetch(
    `${target}/v1/rooms/smoke-room/generations/1/socket`,
  );
  expect(response.status === 426, `status ${response.status}`);
});

await check("malformed socket identity closes with 404", async () => {
  const response = await fetch(
    `${target}/v1/rooms/smoke-room/generations/01/socket`,
  );
  expect(response.status === 404, `status ${response.status}`);
});

await check("control refuses non-POST with 405", async () => {
  const response = await fetch(`${target}/v1/control`);
  expect(response.status === 405, `status ${response.status}`);
});

await check("control refuses non-JSON content type with 415", async () => {
  const response = await fetch(`${target}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "token=x",
  });
  expect(response.status === 415, `status ${response.status}`);
});

await check("control closes malformed JSON with 400", async () => {
  const response = await fetch(`${target}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expect(response.status === 400, `status ${response.status}`);
});

await check("control rejects an unsigned token with 401", async () => {
  const response = await fetch(`${target}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "smoke.smoke" }),
  });
  expect(response.status === 401, `status ${response.status}`);
});

const secret = process.env.COLLAB_JOIN_TOKEN_SECRET;
if (!secret) {
  console.log(
    "\nSKIP  WebSocket room-runtime smoke (set COLLAB_JOIN_TOKEN_SECRET to run it)",
  );
} else {
  await webSocketSmoke(secret);
}

/**
 * One raw smoke client: a `ws` socket (which, unlike the WHATWG client, can
 * present the allowlisted Origin) feeding the *shared* conformance event
 * queue, so this script and the two conformance suites read the wire through
 * one implementation. The raw socket stays exposed: the shared queue filters
 * keepalive acknowledgments by contract, and the keepalive check below needs
 * to observe the exact frame.
 */
function connectSmokeClient(roomId) {
  const url = `${target.replace(/^http/, "ws")}/v1/rooms/${roomId}/generations/1/socket`;
  const socket = new WebSocket(url, { headers: { Origin: SMOKE_ORIGIN } });
  socket.binaryType = "arraybuffer";
  const { connection, push } = createConformanceConnection({
    send: (data) => socket.send(data),
    close: () => socket.close(1000, "smoke finished"),
  });
  socket.on("message", (data, isBinary) => {
    const bytes =
      data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.concat([data].flat());
    if (isBinary) push({ kind: "binary", bytes: new Uint8Array(bytes) });
    else push({ kind: "text", text: bytes.toString("utf8") });
  });
  socket.on("close", (code, reason) =>
    push({ kind: "close", code, reason: reason.toString("utf8") }),
  );
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`upgrade refused with status ${response.statusCode}`)),
    );
  });
  // The smoke's historical default event timeout is kept at 10 s: this runs
  // over the real network, not against a local workerd.
  return { socket, next: (timeoutMs = 10_000) => connection.next(timeoutMs), opened };
}

async function webSocketSmoke(joinTokenSecret) {
  // A room id no real traffic can collide with; the room's Object cleans
  // itself up after its (one hour) expiry passes.
  const roomId = roomIdSchema.parse(
    `smoke-${Date.now().toString(36)}-${createRoomTokenId().slice(0, 8)}`,
  );
  const issue = (subject) => {
    const now = Math.floor(Date.now() / 1000);
    return signJoinToken(
      {
        v: ROOM_TOKEN_VERSION,
        jti: createRoomTokenId(),
        iat: now,
        exp: now + 60,
        aud: ROOM_TOKEN_AUDIENCES.join,
        rid: roomId,
        gen: 1,
        sub: subject,
        role: "editor",
        arev: 1,
        rexp: now + 3_600,
      },
      joinTokenSecret,
    );
  };
  const joinFrame = (subject) =>
    encodeRelayControl({
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId,
      token: issue(subject),
    });
  const expectJoined = async (client) => {
    const event = await client.next();
    expect(event.kind === "text", `expected joined ack, got ${event.kind}`);
    const control = parseRelayServerControl(event.text);
    expect(control?.control === "joined", `unexpected control: ${event.text}`);
    return control;
  };

  // One shared room key that never leaves this process: the deployed Worker
  // must route the sealed bytes verbatim without being able to read them.
  const roomKey = generateRoomKey();
  const codecFor = () =>
    createRealtimeCryptoCodec({ roomKey, roomId, authGeneration: 1 });

  let alice;
  let bob;
  await check("two clients join a room on the deployed Worker", async () => {
    alice = connectSmokeClient(roomId);
    await alice.opened;
    alice.socket.send(joinFrame("smoke-alice"));
    const joinedA = await expectJoined(alice);
    bob = connectSmokeClient(roomId);
    await bob.opened;
    bob.socket.send(joinFrame("smoke-bob"));
    const joinedB = await expectJoined(bob);
    expect(
      joinedA.roomGeneration === joinedB.roomGeneration,
      "cohort must share one room generation",
    );
    const peersNotice = await alice.next();
    expect(peersNotice.kind === "text", "expected peers broadcast");
  });

  await check(
    "E2EE scene frame converges between the two clients",
    async () => {
      const sealer = await codecFor();
      const opener = await codecFor();
      const plaintext = new TextEncoder().encode("smoke-e2ee-convergence");
      const sealed = await sealer.seal(plaintext, "scene");
      expect(sealed.ok, "seal failed");
      alice.socket.send(encodeRelayDataFrame("scene", sealed.frame));
      const delivered = await bob.next();
      expect(
        delivered.kind === "binary",
        `expected binary, got ${delivered.kind}`,
      );
      const decoded = decodeRelayDataFrame(delivered.bytes);
      expect(decoded?.channel === "scene", "expected the scene channel");
      const openedFrame = await opener.open(decoded.payload, "scene");
      expect(openedFrame.ok, "sealed frame did not authenticate");
      expect(
        new TextDecoder().decode(openedFrame.plaintext) ===
          "smoke-e2ee-convergence",
        "plaintext mismatch",
      );
    },
  );

  await check(
    "E2EE presence frame converges in the other direction",
    async () => {
      const sealer = await codecFor();
      const opener = await codecFor();
      const sealed = await sealer.seal(
        new TextEncoder().encode("smoke-presence"),
        "presence",
      );
      expect(sealed.ok, "seal failed");
      bob.socket.send(encodeRelayDataFrame("presence", sealed.frame));
      const delivered = await alice.next();
      expect(
        delivered.kind === "binary",
        `expected binary, got ${delivered.kind}`,
      );
      const decoded = decodeRelayDataFrame(delivered.bytes);
      expect(decoded?.channel === "presence", "expected the presence channel");
      const openedFrame = await opener.open(decoded.payload, "presence");
      expect(openedFrame.ok, "sealed frame did not authenticate");
    },
  );

  await check("keepalive auto-response answers the exact frame", async () => {
    // The shared event queue filters keepalive acknowledgments (their
    // presence is contractually optional), so this check listens on the raw
    // socket for the exact frame.
    const acknowledged = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no keepalive acknowledgment within 10 s")),
        10_000,
      );
      const onMessage = (data, isBinary) => {
        const bytes =
          data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat([data].flat());
        if (!isBinary && bytes.toString("utf8") === RELAY_KEEPALIVE_RESPONSE) {
          clearTimeout(timer);
          alice.socket.off("message", onMessage);
          resolve(undefined);
        }
      };
      alice.socket.on("message", onMessage);
    });
    alice.socket.send(RELAY_KEEPALIVE_REQUEST);
    await acknowledged;
  });

  await check("leave closes both sessions normally", async () => {
    // Membership notices for the other member's departure may precede the
    // own close event; drain to the close.
    const nextClose = async (client) => {
      for (let events = 0; events < 8; events += 1) {
        const event = await client.next();
        if (event.kind === "close") return event;
      }
      throw new Error("no close event arrived");
    };
    alice.socket.send(encodeRelayControl({ control: "leave" }));
    bob.socket.send(encodeRelayControl({ control: "leave" }));
    const closedA = await nextClose(alice);
    const closedB = await nextClose(bob);
    expect(closedA.code === 1000, `alice close code ${closedA.code}`);
    expect(closedB.code === 1000, `bob close code ${closedB.code}`);
  });

  // Plan 11 evidence: the Vercel-like HTTP caller → Worker → typed RPC → DO
  // control path against the deployed Worker, still at 0% traffic.
  await check(
    "end-room control applies through the deployed gateway",
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const controlToken = signRoomControlToken(
        {
          v: ROOM_TOKEN_VERSION,
          jti: createRoomTokenId(),
          iat: now,
          exp: now + 30,
          aud: ROOM_TOKEN_AUDIENCES.control,
          rid: roomId,
          gen: 1,
          arev: 2,
          action: "end-room",
        },
        joinTokenSecret,
      );
      const response = await fetch(`${target}/v1/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: controlToken }),
      });
      expect(response.status === 200, `status ${response.status}`);
      const body = await response.json();
      expect(
        body.appliedRevision === 2,
        `appliedRevision ${String(body.appliedRevision)}`,
      );
      expect(typeof body.closed === "number", "closed must be a count");
    },
  );

  await check("a token issued before the end-room is refused", async () => {
    const stale = connectSmokeClient(roomId);
    await stale.opened;
    stale.socket.send(joinFrame("smoke-stale"));
    for (let events = 0; events < 8; events += 1) {
      const event = await stale.next();
      if (event.kind === "close") {
        expect(
          event.code === RELAY_CLOSE_CODES.membershipRevoked,
          `close code ${event.code}`,
        );
        return;
      }
    }
    throw new Error("no close event arrived");
  });
}

if (failures > 0) {
  console.error(`\nsmoke FAILED (${failures})`);
  process.exit(1);
}
console.log("\nsmoke OK");
