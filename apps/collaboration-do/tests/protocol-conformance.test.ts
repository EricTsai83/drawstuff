import { SELF } from "cloudflare:test";
import { afterEach, describe, it } from "vitest";

import {
  relayProtocolConformanceCases,
  type ConformanceHarness,
} from "@drawstuff/collaboration/protocol-conformance";
import {
  DO_GATEWAY_CONTROL_PATH,
  doGatewayControlResponseSchema,
} from "@drawstuff/collaboration/relay-control";

import { TEST_ROOM_TOKEN_SECRET } from "./support/audit.ts";
import {
  GATEWAY_BASE,
  openSocket,
  settleRoomEvents,
} from "./support/room-socket.ts";

afterEach(settleRoomEvents);

/**
 * The shared black-box wire-contract suite, driven end to end through the
 * real gateway into the real Durable Object inside workerd. The Node relay
 * runs the *same cases* in
 * `apps/collaboration-relay/tests/protocol-conformance.integration.test.ts`,
 * which is what makes protocol parity a tested property instead of a
 * documentation promise: a divergence fails one of the two suites.
 */
const harness: ConformanceHarness = {
  secret: TEST_ROOM_TOKEN_SECRET,
  async connect(roomId, authGeneration = 1) {
    const { connection } = await openSocket(roomId, authGeneration);
    return connection;
  },
  async control(token) {
    const response = await SELF.fetch(
      `${GATEWAY_BASE}${DO_GATEWAY_CONTROL_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );
    if (response.status === 401) return { accepted: false, closed: 0 };
    if (response.status !== 200) {
      throw new Error(`control endpoint answered ${response.status}`);
    }
    const parsed = doGatewayControlResponseSchema.parse(await response.json());
    return { accepted: true, closed: parsed.closed };
  },
};

describe("Durable Object room runtime — shared protocol conformance", () => {
  for (const conformanceCase of relayProtocolConformanceCases) {
    it(conformanceCase.name, { timeout: 30_000 }, async () => {
      await conformanceCase.run(harness);
    });
  }
});
