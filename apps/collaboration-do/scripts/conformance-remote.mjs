#!/usr/bin/env node
/**
 * Runs the shared black-box conformance suite against a *deployed*
 * collaboration Worker (Plan 12b P1).
 *
 * The exact cases the workerd and Node-relay suites run
 * (`@drawstuff/collaboration/protocol-conformance`) are driven here over the
 * real network: `ws` sockets that present the allowlisted Origin, real signed
 * join tokens, and the control endpoint over HTTPS. Intended only for the
 * 0%-traffic window — the namespace holds nothing but synthetic rooms, and
 * every room this run creates expires on its own token-bounded lifetime.
 *
 * Usage:
 *   COLLAB_JOIN_TOKEN_SECRET=... \
 *   pnpm --filter @drawstuff/collaboration-do conformance:remote <base-url> [case-filter]
 *
 * The optional second argument is a case-name substring filter, for rerunning
 * one failing case without the full (several-minute) suite.
 */

import { WebSocket } from "ws";

import {
  createConformanceConnection,
  relayProtocolConformanceCases,
} from "@drawstuff/collaboration/protocol-conformance";
import {
  DO_GATEWAY_CONTROL_PATH,
  doGatewayControlResponseSchema,
} from "@drawstuff/collaboration/relay-control";

const base = process.argv[2];
if (!base) {
  console.error(
    "usage: pnpm --filter @drawstuff/collaboration-do conformance:remote <base-url> [case-filter]",
  );
  process.exit(2);
}
const target = base.replace(/\/+$/, "");
const caseFilter = process.argv[3];

const secret = process.env.COLLAB_JOIN_TOKEN_SECRET;
if (!secret) {
  console.error(
    "COLLAB_JOIN_TOKEN_SECRET is required: the suite signs real join and control tokens",
  );
  process.exit(2);
}

/** Must be on the deployed Worker's COLLAB_ALLOWED_ORIGINS allowlist. */
const ORIGIN = process.env.COLLAB_SMOKE_ORIGIN ?? "http://localhost:3000";

/** @type {import("@drawstuff/collaboration/protocol-conformance").ConformanceHarness} */
const harness = {
  secret,
  connect(roomId, authGeneration = 1) {
    const url = `${target.replace(/^http/, "ws")}/v1/rooms/${roomId}/generations/${authGeneration}/socket`;
    // `ws` rather than the WHATWG client: only it can present the Origin.
    const socket = new WebSocket(url, { headers: { Origin: ORIGIN } });
    socket.binaryType = "arraybuffer";
    const { connection, push } = createConformanceConnection({
      send: (data) => socket.send(data),
      close: () => socket.close(1000, "conformance finished"),
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
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(connection));
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`upgrade refused with status ${response.statusCode}`)),
      );
    });
  },
  async control(token) {
    const response = await fetch(`${target}${DO_GATEWAY_CONTROL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.status === 401) return { accepted: false, closed: 0 };
    if (response.status !== 200) {
      throw new Error(`control endpoint answered ${response.status}`);
    }
    const parsed = doGatewayControlResponseSchema.parse(await response.json());
    return { accepted: true, closed: parsed.closed };
  },
};

const cases = relayProtocolConformanceCases.filter(
  (conformanceCase) =>
    caseFilter === undefined || conformanceCase.name.includes(caseFilter),
);
if (cases.length === 0) {
  console.error(`no case matches the filter: ${caseFilter}`);
  process.exit(2);
}

console.log(`conformance-remote: ${cases.length} cases against ${target}\n`);
let failures = 0;
// Sequential on purpose: cases sized around per-connection budgets must not
// share the network path with a concurrent flood case.
for (const conformanceCase of cases) {
  const startedAt = Date.now();
  try {
    await conformanceCase.run(harness);
    console.log(`PASS  ${conformanceCase.name} (${Date.now() - startedAt} ms)`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${conformanceCase.name}`);
    console.error(`      ${error instanceof Error ? error.message : error}`);
  }
}

if (failures > 0) {
  console.error(`\nconformance-remote FAILED (${failures}/${cases.length})`);
  process.exit(1);
}
console.log(`\nconformance-remote OK (${cases.length} cases)`);
process.exit(0);
