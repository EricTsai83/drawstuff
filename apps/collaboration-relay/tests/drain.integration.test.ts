import { connect as netConnect, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import {
  disconnectReasonForCloseCode,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import { RELAY_HEALTH_PATH } from "../src/monitoring.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { createTestLogger, type TestLogger } from "./support/observability.ts";
import { TEST_ROOM_TOKEN_SECRET } from "./support/room-tokens.ts";
import {
  createTestClient,
  waitUntil,
  type TestClient,
} from "./support/test-client.ts";

/**
 * Plan 25: the graceful-drain sequence. A restart or replacement must not be a
 * mass 1006 — every attached client leaves with a close code its recovery
 * treats as retryable, inside a bounded window, and the process refuses new
 * work the moment the drain starts.
 */

const ROOM_ID = roomIdSchema.parse("room-drain");
const CLIENT_A = clientIdSchema.parse("client-a");
const CLIENT_B = clientIdSchema.parse("client-b");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startServer(
  options: Partial<Parameters<typeof createRelayServer>[0]> = {},
): Promise<{ server: RelayServer; logs: TestLogger }> {
  const logs = createTestLogger();
  const server = await createRelayServer({
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
    logger: logs.logger,
    ...options,
  });
  cleanups.push(() => server.close());
  return { server, logs };
}

async function joinedClient(
  url: string,
  clientId: typeof CLIENT_A,
  nonceSeed: number,
): Promise<TestClient> {
  const testClient = await createTestClient({
    url,
    roomId: ROOM_ID,
    clientId,
    nonceSeed,
  });
  cleanups.push(() => testClient.close());
  await testClient.connect();
  return testClient;
}

const rawSocket = (url: string): Promise<WsClient> => {
  const socket = new WsClient(url);
  cleanups.push(() => socket.terminate());
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const closeCodeOf = (socket: WsClient): Promise<number> =>
  new Promise((resolve) => socket.once("close", (code) => resolve(code)));

/**
 * A WebSocket connection that will never complete a close handshake: the
 * upgrade is performed by hand and every relay frame after it — including the
 * close frame the drain sends — is read and ignored. This is the socket the
 * bounded window exists for.
 */
const unresponsiveSocket = (port: number): Promise<Socket> => {
  const socket = netConnect(port, "127.0.0.1");
  cleanups.push(() => {
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("data", () => resolve(socket));
    socket.write(
      [
        "GET / HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    socket.on("data", () => {
      // Swallow everything, answer nothing.
    });
  });
};

describe("relay graceful drain", () => {
  it("treats the drain close code as retryable on the client side", () => {
    // The contract the whole sequence rests on: recovery must carry a drained
    // client to the replacement process, so the code must read as transient.
    expect(
      disconnectReasonForCloseCode(RELAY_CLOSE_CODES.relayRestarting),
    ).toBe("transient");
  });

  it("closes every attached connection with the retryable code inside the window", async () => {
    const { server, logs } = await startServer();
    const first = await rawSocket(server.url);
    const second = await rawSocket(server.url);
    const codes = Promise.all([closeCodeOf(first), closeCodeOf(second)]);

    await server.drain();

    expect(await codes).toEqual([
      RELAY_CLOSE_CODES.relayRestarting,
      RELAY_CLOSE_CODES.relayRestarting,
    ]);
    expect(server.connectionCount()).toBe(0);
    const drained = logs.recordsOf("relay.drained");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      connections: 2,
      forcedTerminations: 0,
    });
    // Both closes are attributed to the drain, not to the peers, and each
    // connection record carries the code alongside the reason — the drain goes
    // through the connection's own close path, not around it.
    expect(server.renderMetrics()).toContain(
      'relay_connections_closed_total{reason="relayRestarting"} 2',
    );
    const closedRecords = logs.recordsOf("relay.connection_closed");
    expect(closedRecords).toHaveLength(2);
    for (const record of closedRecords) {
      expect(record).toMatchObject({
        closeCode: RELAY_CLOSE_CODES.relayRestarting,
        closeReason: "relayRestarting",
      });
    }
  });

  it("reports unhealthy and refuses new connections once draining", async () => {
    const { server } = await startServer();
    await server.drain();

    const health = await fetch(`${server.controlUrl}${RELAY_HEALTH_PATH}`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "draining" });

    // Still refused after the drain has completed: the process never comes
    // back from draining, it exits and is replaced.
    const late = await rawSocket(server.url);
    expect(await closeCodeOf(late)).toBe(RELAY_CLOSE_CODES.relayRestarting);
  });

  it("force-terminates and counts sockets that sit out the close handshake", async () => {
    // The join deadline expires inside the drain window on purpose: the drain
    // releases the connection's own deadlines when it issues the close, so no
    // competing close path may re-attribute the disconnect mid-drain.
    const { server, logs } = await startServer({
      limits: { drainTimeoutMs: 200, joinTimeoutMs: 100 },
    });
    await unresponsiveSocket(server.port);
    await waitUntil(
      () => server.connectionCount() === 1,
      "the unresponsive socket to be accepted",
    );

    await server.drain();

    const drained = logs.recordsOf("relay.drained");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ connections: 1, forcedTerminations: 1 });
    // Bounded: the drain ended by the deadline, not by the peer's goodwill.
    expect(drained[0]?.durationMs).toBeLessThan(5_000);
    // The disconnect was recorded as `relayRestarting` when the drain issued
    // the close; the deadline's terminate is transport-level force, counted in
    // `forcedTerminations` rather than attributed as a second disconnect.
    expect(server.renderMetrics()).toContain(
      'relay_connections_closed_total{reason="relayRestarting"} 1',
    );
    // The join deadline that expired mid-drain did not fire: the drain had
    // already released it.
    expect(server.renderMetrics()).toContain(
      'relay_connections_closed_total{reason="joinTimeout"} 0',
    );
  });

  it("is idempotent: concurrent callers share one drain", async () => {
    const { server, logs } = await startServer();
    await rawSocket(server.url);

    await Promise.all([server.drain(), server.drain()]);
    await server.drain();

    expect(logs.recordsOf("relay.draining")).toHaveLength(1);
    expect(logs.recordsOf("relay.drained")).toHaveLength(1);
  });

  it("drains joined clients so they reconnect to the replacement process", async () => {
    const { server } = await startServer();
    const port = server.port;
    const a = await joinedClient(server.url, CLIENT_A, 1);
    const b = await joinedClient(server.url, CLIENT_B, 2);
    a.upsertElement("el-before", "pre-drain");
    await waitUntil(
      () => a.digest() === b.digest() && a.elementIds().length > 0,
      "pre-drain convergence",
    );

    await server.drain();
    await a.waitForDisconnect();
    await b.waitForDisconnect();
    // "以可重試原因斷線": the transport classified the drain as transient,
    // which is what lets recovery retry instead of ending the session.
    expect(a.connectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
    expect(b.connectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
    await server.close();

    // The replacement process: same address, fresh state.
    await startServer({ port });
    await a.connect();
    await b.connect();
    b.upsertElement("el-after", "post-drain");
    await waitUntil(
      () => a.digest() === b.digest() && a.elementIds().length === 2,
      "post-drain convergence on the replacement",
    );
    expect(a.elementIds()).toEqual(["el-after", "el-before"]);
  });
});
