import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import { createInMemoryRoomFanout, type RoomFanout } from "../src/fanout.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import {
  createTestClient,
  waitUntil,
  type TestClient,
} from "./support/test-client.ts";

const ROOM_ID = roomIdSchema.parse("room-integration");
const CLIENT_A = clientIdSchema.parse("client-a");
const CLIENT_B = clientIdSchema.parse("client-b");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startServer(
  options: Parameters<typeof createRelayServer>[0] = {},
): Promise<RelayServer> {
  const server = await createRelayServer(options);
  cleanups.push(() => server.close());
  return server;
}

function client(
  url: string,
  clientId: typeof CLIENT_A,
  nonceSeed: number,
): TestClient {
  const testClient = createTestClient({
    url,
    roomId: ROOM_ID,
    clientId,
    nonceSeed,
  });
  cleanups.push(() => testClient.close());
  return testClient;
}

const converged = (a: TestClient, b: TestClient): boolean =>
  a.digest() === b.digest() && a.elementIds().length > 0;

const rawSocket = (
  url: string,
  options?: { autoPong?: boolean },
): Promise<WsClient> => {
  const socket = new WsClient(url, options);
  cleanups.push(() => socket.terminate());
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const closeCodeOf = (socket: WsClient): Promise<number> =>
  new Promise((resolve) => socket.once("close", (code) => resolve(code)));

describe("relay server integration", () => {
  it("converges two clients editing concurrently through the relay", async () => {
    const server = await startServer();
    const a = client(server.url, CLIENT_A, 1);
    const b = client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();

    a.upsertElement("el-a1", "from-a");
    a.upsertElement("el-a2", "from-a");
    b.upsertElement("el-b1", "from-b");
    // Concurrent write to the same element: both sides must settle on one
    // winner via the shared version/nonce rule.
    a.upsertElement("el-shared", "a-version");
    b.upsertElement("el-shared", "b-version");

    await waitUntil(() => converged(a, b), "clients to converge");
    expect(a.elementIds()).toEqual(["el-a1", "el-a2", "el-b1", "el-shared"]);
    expect(server.roomCount()).toBe(1);
  });

  it("hands a joining client the existing scene via the snapshot handshake", async () => {
    const server = await startServer();
    const a = client(server.url, CLIENT_A, 1);
    await a.connect();
    a.upsertElement("el-early", "before-b-joined");

    const b = client(server.url, CLIENT_B, 2);
    await b.connect();
    await waitUntil(() => converged(a, b), "late joiner to converge");
    expect(b.elementIds()).toEqual(["el-early"]);
  });

  it("reports room membership to both clients", async () => {
    const server = await startServer();
    const a = client(server.url, CLIENT_A, 1);
    const b = client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();

    await waitUntil(
      () => a.peers().length === 2 && b.peers().length === 2,
      "membership to propagate",
    );
    const clientIds = a
      .peers()
      .map((peer) => peer.clientId)
      .sort();
    expect(clientIds).toEqual(["client-a", "client-b"]);

    b.disconnect();
    await waitUntil(() => a.peers().length === 1, "leave to propagate");
  });

  it("delivers volatile presence between clients", async () => {
    const server = await startServer();
    const a = client(server.url, CLIENT_A, 1);
    const b = client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();

    a.sendPresence(11, 22);
    await waitUntil(
      () => b.presenceReceived().length > 0,
      "presence to arrive",
    );
    expect(b.presenceReceived()[0]?.payload.pointer).toEqual({
      x: 11,
      y: 22,
      tool: "pointer",
    });
  });

  it("keeps scenes converging when every presence frame is lost in transit", async () => {
    const inner = createInMemoryRoomFanout();
    const presenceLossFanout: RoomFanout = {
      ...inner,
      publish(roomId, senderPeerId, channel, frame) {
        if (channel === "presence") return;
        inner.publish(roomId, senderPeerId, channel, frame);
      },
    };
    const server = await startServer({ fanout: presenceLossFanout });
    const a = client(server.url, CLIENT_A, 1);
    const b = client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();

    a.sendPresence(1, 1);
    a.upsertElement("el-1", "survives presence loss");
    b.upsertElement("el-2", "survives presence loss");

    await waitUntil(() => converged(a, b), "scene to converge");
    expect(b.presenceReceived()).toHaveLength(0);
  });

  it("recovers from a relay restart with a fresh room generation", async () => {
    const server = await startServer();
    const port = server.port;
    const a = client(server.url, CLIENT_A, 1);
    const b = client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("el-before", "pre-restart");
    await waitUntil(() => converged(a, b), "pre-restart convergence");
    const generationBefore = a.roomGeneration();
    if (generationBefore === undefined) throw new Error("not connected");

    await server.close();
    await waitUntil(
      () =>
        a.connectionState().status === "disconnected" &&
        b.connectionState().status === "disconnected",
      "clients to observe the restart",
    );

    // Edits made while the relay is down live only in each client's scene.
    a.upsertElement("el-offline-a", "while-down");
    b.upsertElement("el-offline-b", "while-down");

    await startServer({ port });
    await a.connect();
    await b.connect();

    const generationAfter = a.roomGeneration();
    if (generationAfter === undefined) throw new Error("not reconnected");
    expect(generationAfter).toBeGreaterThan(generationBefore);

    await waitUntil(() => converged(a, b), "post-restart convergence");
    expect(a.elementIds()).toEqual([
      "el-before",
      "el-offline-a",
      "el-offline-b",
    ]);
  });

  it("releases all room state after clients leave (room churn)", async () => {
    const server = await startServer();
    for (let round = 0; round < 3; round += 1) {
      const a = client(server.url, CLIENT_A, 1);
      const b = client(server.url, CLIENT_B, 2);
      await a.connect();
      await b.connect();
      a.upsertElement(`el-${round}`, "churn");
      b.disconnect();
      a.disconnect();
    }
    await waitUntil(
      () => server.roomCount() === 0 && server.connectionCount() === 0,
      "server to release all rooms and sockets",
    );
  });

  it("refuses connections beyond the relay-wide cap", async () => {
    const server = await startServer({ limits: { maxConnections: 1 } });
    await rawSocket(server.url);
    const second = await rawSocket(server.url);
    expect(await closeCodeOf(second)).toBe(RELAY_CLOSE_CODES.relayAtCapacity);
  });

  it("refuses joins beyond the per-room cap", async () => {
    const server = await startServer({
      limits: { maxConnectionsPerRoom: 1 },
    });
    const a = client(server.url, CLIENT_A, 1);
    await a.connect();

    const socket = await rawSocket(server.url);
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_B,
      }),
    );
    expect(await closeCodeOf(socket)).toBe(RELAY_CLOSE_CODES.roomAtCapacity);
  });

  it("closes a socket that sends an oversize frame", async () => {
    const server = await startServer();
    const socket = await rawSocket(server.url);
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_A,
      }),
    );
    // Past the transport-level maxPayload: ws refuses it with 1009 without
    // ever buffering the full frame into relay memory.
    const oversize = new Uint8Array(1_048_578);
    oversize[0] = 0x01;
    socket.send(oversize);
    expect(await closeCodeOf(socket)).toBe(1009);
  });

  it("closes a joined socket that sends an over-budget presence frame", async () => {
    const server = await startServer();
    const socket = await rawSocket(server.url);
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_A,
      }),
    );
    const oversizePresence = new Uint8Array(16_386);
    oversizePresence[0] = 0x02;
    socket.send(oversizePresence);
    expect(await closeCodeOf(socket)).toBe(
      RELAY_CLOSE_CODES.protocolViolation,
    );
  });

  it("closes sockets that never join within the deadline", async () => {
    const server = await startServer({ limits: { joinTimeoutMs: 100 } });
    const socket = await rawSocket(server.url);
    expect(await closeCodeOf(socket)).toBe(RELAY_CLOSE_CODES.joinTimeout);
  });

  it("terminates unresponsive sockets via the heartbeat", async () => {
    const server = await startServer({
      limits: { heartbeatIntervalMs: 50 },
    });
    // autoPong off simulates a dead connection that still holds the TCP
    // socket open: the relay must reclaim it within ~2 intervals.
    const socket = await rawSocket(server.url, { autoPong: false });
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_A,
      }),
    );
    expect(await closeCodeOf(socket)).toBe(1006);
    await waitUntil(
      () => server.connectionCount() === 0 && server.roomCount() === 0,
      "heartbeat to reclaim the dead socket",
    );
  });
});
