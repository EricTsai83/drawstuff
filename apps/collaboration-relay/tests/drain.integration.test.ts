import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import {
  disconnectReasonForCloseCode,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import { RELAY_HEALTH_PATH } from "../src/monitoring.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { createTestLogger, type TestLogger } from "./support/observability.ts";
import {
  issueJoinToken,
  TEST_ROOM_TOKEN_SECRET,
} from "./support/room-tokens.ts";
import {
  createTestClient,
  waitUntil,
  type TestClient,
} from "./support/test-client.ts";
import { openUnresponsiveSocket } from "./support/unresponsive-socket.ts";

/**
 * Plan 25: the graceful-drain sequence. A restart or replacement must not be a
 * mass 1006 — every attached client leaves with a close code its recovery
 * treats as retryable, inside a bounded window, and the process refuses new
 * work the moment the drain starts.
 */

const ROOM_ID = roomIdSchema.parse("room-drain");
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

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
  clientName: string,
  nonceSeed: number,
): Promise<TestClient> {
  const testClient = await createTestClient({
    url,
    roomId: ROOM_ID,
    clientName,
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

const unresponsiveSocket = (port: number): Promise<Socket> =>
  openUnresponsiveSocket(port, (cleanup) => cleanups.push(cleanup));

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

  it("attributes a genuinely backpressured member to the drain, not the slow-consumer policy", async () => {
    // The two-phase ordering guarantee, exercised over real ws sockets: a
    // member whose outbound buffer is over budget at drain time must leave as
    // `relayRestarting` — phase one puts every socket into CLOSING before any
    // membership release can broadcast a peers update into its full buffer and
    // steal the close as `slowConsumer`.
    const { server, logs } = await startServer({
      limits: {
        maxBufferedBytes: 64 * 1024,
        // Equal on purpose: the moment a presence drop is observable, the
        // buffer is provably over the scene budget too.
        presenceDropBufferedBytes: 64 * 1024,
        drainTimeoutMs: 500,
        rateLimits: {
          sceneFramesPerSecond: 1_000_000,
          sceneFramesBurst: 1_000_000,
          sceneBytesPerSecond: 1_000_000_000,
          sceneBytesBurst: 1_000_000_000,
          presenceFramesPerSecond: 1_000_000,
          presenceFramesBurst: 1_000_000,
        },
      },
    });
    const join = (socket: WsClient, subject: string): void => {
      socket.send(
        JSON.stringify({
          control: "join",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          roomId: ROOM_ID,
          token: issueJoinToken({
            roomId: ROOM_ID,
            subject,
            issuedAtSeconds: Math.floor(Date.now() / 1000),
          }),
        }),
      );
    };
    const stalled = await rawSocket(server.url);
    join(stalled, "user-stalled");
    const sender = await rawSocket(server.url);
    join(sender, "user-sender");
    await waitUntil(() => server.sessionCount() === 2, "both members to join");

    // The stalled member stops reading; presence frames pile up in its
    // server-side socket buffer until the relay observes real backpressure.
    stalled.pause();
    const presence = new Uint8Array(16_000);
    presence[0] = 0x02;
    const droppedPresence = (): number => {
      const match = /relay_presence_frames_dropped_total (\d+)/.exec(
        server.renderMetrics(),
      );
      return match ? Number(match[1]) : 0;
    };
    await waitUntil(
      () => {
        if (droppedPresence() > 0) return true;
        for (let burst = 0; burst < 20; burst += 1) sender.send(presence);
        return false;
      },
      "the stalled member's outbound buffer to exceed the scene budget",
      // How fast the buffer fills depends on the OS's socket buffer sizes, so
      // this wait gets explicit headroom over the default.
      30_000,
    );

    await server.drain();

    const drained = logs.recordsOf("relay.drained");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ connections: 2 });
    // Both disconnects belong to the drain; the over-budget buffer never
    // re-attributed the stalled member as a slow consumer.
    expect(server.renderMetrics()).toContain(
      'relay_connections_closed_total{reason="relayRestarting"} 2',
    );
    expect(server.renderMetrics()).toContain(
      'relay_connections_closed_total{reason="slowConsumer"} 0',
    );
    for (const record of logs.recordsOf("relay.connection_closed")) {
      expect(record).toMatchObject({ closeReason: "relayRestarting" });
    }
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
