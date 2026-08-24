import { afterAll, beforeAll, describe, it } from "vitest";

import { WebSocket } from "ws";

import {
  createConformanceConnection,
  relayProtocolConformanceCases,
  type ConformanceHarness,
} from "@drawstuff/collaboration/protocol-conformance";
import {
  RELAY_CONTROL_PATH,
  relayControlResponseSchema,
} from "@drawstuff/collaboration/relay-control";

import { createRelayServer, type RelayServer } from "../src/server.ts";
import { TEST_ROOM_TOKEN_SECRET } from "./support/room-tokens.ts";

/**
 * The shared black-box wire-contract suite against a live relay server. The
 * Durable Object room runtime runs the *same cases* inside workerd
 * (`apps/collaboration-do/tests/protocol-conformance.test.ts`); together the
 * two runs are what make "one wire contract, two backends" a tested property.
 */

let server: RelayServer;

beforeAll(async () => {
  server = await createRelayServer({
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
  });
});

afterAll(async () => {
  await server.close();
});

const harness: ConformanceHarness = {
  secret: TEST_ROOM_TOKEN_SECRET,
  async connect() {
    // The relay routes purely on the verified token; the room addressing in
    // the URL is a Durable-Object-gateway concern it does not have.
    const socket = new WebSocket(server.url);
    socket.binaryType = "arraybuffer";
    const { connection, push } = createConformanceConnection({
      send: (data) => socket.send(data),
      close: () => socket.close(1000, "test finished"),
    });
    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (isBinary) {
        push({ kind: "binary", bytes: new Uint8Array(bytes) });
      } else {
        push({ kind: "text", text: bytes.toString("utf8") });
      }
    });
    socket.on("close", (code, reason) => {
      push({ kind: "close", code, reason: reason.toString("utf8") });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    return connection;
  },
  async control(token) {
    const response = await fetch(`${server.controlUrl}${RELAY_CONTROL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.status === 401) return { accepted: false, closed: 0 };
    if (response.status !== 200) {
      throw new Error(`control endpoint answered ${response.status}`);
    }
    const parsed = relayControlResponseSchema.parse(await response.json());
    return { accepted: true, closed: parsed.closed };
  },
};

describe("Node relay — shared protocol conformance", () => {
  for (const conformanceCase of relayProtocolConformanceCases) {
    it(conformanceCase.name, { timeout: 30_000 }, async () => {
      await conformanceCase.run(harness);
    });
  }
});
