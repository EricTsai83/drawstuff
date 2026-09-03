#!/usr/bin/env node
/**
 * Runs the shared black-box conformance suite against a *deployed*
 * collaboration Worker.
 *
 * The exact cases the workerd suite runs
 * (`@drawstuff/collaboration/protocol-conformance`) are driven here over the
 * real network: `ws` sockets that present the allowlisted Origin, real signed
 * join tokens, and the control endpoint over HTTPS. Every room this run
 * creates is synthetic and expires on its own token-bounded lifetime.
 *
 * Usage:
 *   COLLAB_JOIN_TOKEN_SECRET=... \
 *   pnpm --filter @drawstuff/collaboration-do conformance:remote <base-url> [case-filter]
 *
 * The optional second argument is a case-name substring filter, for rerunning
 * one failing case without the full (several-minute) suite.
 */

import { relayProtocolConformanceCases } from "@drawstuff/collaboration/protocol-conformance";
import {
  DO_GATEWAY_CONTROL_PATH,
  doGatewayControlResponseSchema,
} from "@drawstuff/collaboration/relay-control";

import { openConformanceSocket, roomSocketUrl } from "./ws-harness.mjs";

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

/** @type {import("@drawstuff/collaboration/protocol-conformance").ConformanceHarness} */
const harness = {
  secret,
  async connect(roomId, authGeneration = 1) {
    const { connection, opened } = openConformanceSocket({
      url: roomSocketUrl(target, roomId, authGeneration),
      closeReason: "conformance finished",
    });
    await opened;
    return connection;
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
