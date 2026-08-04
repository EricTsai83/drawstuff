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
import { MAX_ROOM_TOKEN_BYTES } from "@drawstuff/collaboration/room-auth";

import { RELAY_CONTROL_PATH } from "../src/control.ts";
import { createInMemoryRoomFanout, type RoomFanout } from "../src/fanout.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import {
  issueControlToken,
  issueJoinToken,
  TEST_ROOM_TOKEN_SECRET,
} from "./support/room-tokens.ts";
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
  options: Partial<Parameters<typeof createRelayServer>[0]> = {},
): Promise<RelayServer> {
  const server = await createRelayServer({
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
    ...options,
  });
  cleanups.push(() => server.close());
  return server;
}

function client(
  url: string,
  clientId: typeof CLIENT_A,
  nonceSeed: number,
  overrides: { role?: "owner" | "editor" | "viewer"; subject?: string } = {},
): TestClient {
  const testClient = createTestClient({
    url,
    roomId: ROOM_ID,
    clientId,
    nonceSeed,
    ...overrides,
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
      publish(channel, senderPeerId, messageChannel, frame) {
        if (messageChannel === "presence") return;
        inner.publish(channel, senderPeerId, messageChannel, frame);
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
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: CLIENT_B,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
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
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: CLIENT_A,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
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
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: CLIENT_A,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
      }),
    );
    const oversizePresence = new Uint8Array(16_386);
    oversizePresence[0] = 0x02;
    socket.send(oversizePresence);
    expect(await closeCodeOf(socket)).toBe(RELAY_CLOSE_CODES.protocolViolation);
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
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: CLIENT_A,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
      }),
    );
    expect(await closeCodeOf(socket)).toBe(1006);
    await waitUntil(
      () => server.connectionCount() === 0 && server.roomCount() === 0,
      "heartbeat to reclaim the dead socket",
    );
  });
});

const postControl = async (
  server: RelayServer,
  body: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${server.controlUrl}${RELAY_CONTROL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
  };
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("relay room authorization and lifecycle", () => {
  it("refuses an unauthorized join and never routes its frames", async () => {
    const server = await startServer();
    const authorized = client(server.url, CLIENT_A, 1);
    await authorized.connect();

    const socket = await rawSocket(server.url);
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_B,
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: CLIENT_B,
          secret: "some-other-secret-that-is-long-enough-01",
          issuedAtSeconds: nowSeconds(),
        }),
      }),
    );
    expect(await closeCodeOf(socket)).toBe(RELAY_CLOSE_CODES.unauthorized);
    expect(server.sessionCount()).toBe(1);
  });

  it("keeps a viewer read-only over the wire while presence still flows", async () => {
    const server = await startServer();
    const editor = client(server.url, CLIENT_A, 1);
    const viewer = createTestClient({
      url: server.url,
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      nonceSeed: 2,
      role: "viewer",
    });
    cleanups.push(() => viewer.close());
    await editor.connect();
    await viewer.connect();

    const viewerState = viewer.connectionState();
    if (viewerState.status !== "connected") throw new Error("not connected");
    expect(viewerState.role).toBe("viewer");

    editor.upsertElement("el-editor", "from-editor");
    await waitUntil(
      () => viewer.elementIds().includes("el-editor"),
      "viewer to receive the editor's element",
    );

    viewer.sendPresence(5, 6);
    await waitUntil(
      () => editor.presenceReceived().length > 0,
      "viewer presence to reach the editor",
    );

    // The transport itself refuses the scene send, so a mis-wired viewer never
    // even reaches the relay's own role check.
    expect(viewer.trySendSceneMutation("el-viewer")).toEqual({
      ok: false,
      error: { code: "read-only-role" },
    });
    expect(editor.elementIds()).toEqual(["el-editor"]);
  });

  it("closes a viewer socket that bypasses the client and publishes a scene frame", async () => {
    const server = await startServer();
    const socket = await rawSocket(server.url);
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_B,
        token: issueJoinToken({
          roomId: ROOM_ID,
          clientId: CLIENT_B,
          role: "viewer",
          issuedAtSeconds: nowSeconds(),
        }),
      }),
    );
    // A hand-built scene data frame: the relay decides on the frame's channel
    // byte alone, with no cooperation from the client.
    const sceneFrame = new Uint8Array([0x01, 0x7b, 0x7d]);
    await waitUntil(() => server.sessionCount() === 1, "viewer to join");
    socket.send(sceneFrame);
    expect(await closeCodeOf(socket)).toBe(RELAY_CLOSE_CODES.readOnlyRole);
  });

  it("disconnects a revoked member and leaves the rest of the room connected", async () => {
    const server = await startServer();
    const owner = client(server.url, CLIENT_A, 1, { subject: "user-owner" });
    const guest = client(server.url, CLIENT_B, 2, { subject: "user-guest" });
    await owner.connect();
    await guest.connect();
    await waitUntil(() => server.sessionCount() === 2, "both members to join");

    const revoked = await postControl(server, {
      token: issueControlToken({
        action: "revoke-member",
        roomId: ROOM_ID,
        subject: "user-guest",
        issuedAtSeconds: nowSeconds(),
      }),
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toEqual({ action: "revoke-member", closed: 1 });

    await waitUntil(
      () => guest.connectionState().status === "disconnected",
      "revoked member to be disconnected",
    );
    expect(owner.connectionState().status).toBe("connected");
    expect(server.sessionCount()).toBe(1);
  });

  it("ends a room generation by closing every session in it", async () => {
    const server = await startServer();
    const a = client(server.url, CLIENT_A, 1);
    const b = client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    await waitUntil(() => server.sessionCount() === 2, "both members to join");

    const ended = await postControl(server, {
      token: issueControlToken({
        action: "end-room",
        roomId: ROOM_ID,
        issuedAtSeconds: nowSeconds(),
      }),
    });
    expect(ended.json).toEqual({ action: "end-room", closed: 2 });

    await waitUntil(
      () =>
        a.connectionState().status === "disconnected" &&
        b.connectionState().status === "disconnected",
      "every member to be disconnected",
    );
    expect(server.roomCount()).toBe(0);
    expect(server.sessionCount()).toBe(0);
  });

  it("isolates room generations from each other", async () => {
    const server = await startServer();
    const oldGeneration = createTestClient({
      url: server.url,
      roomId: ROOM_ID,
      clientId: CLIENT_A,
      nonceSeed: 1,
      authGeneration: 1,
    });
    const newGeneration = createTestClient({
      url: server.url,
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      nonceSeed: 2,
      authGeneration: 2,
    });
    cleanups.push(() => oldGeneration.close());
    cleanups.push(() => newGeneration.close());
    await oldGeneration.connect();
    await newGeneration.connect();

    oldGeneration.upsertElement("el-old", "generation-1");
    newGeneration.upsertElement("el-new", "generation-2");
    // Two rooms, one room id: neither generation can observe the other.
    await waitUntil(() => server.roomCount() === 2, "two room generations");
    expect(oldGeneration.peers()).toHaveLength(1);
    expect(newGeneration.peers()).toHaveLength(1);
    expect(oldGeneration.elementIds()).toEqual(["el-old"]);
    expect(newGeneration.elementIds()).toEqual(["el-new"]);

    // Ending generation 1 leaves generation 2 untouched.
    await postControl(server, {
      token: issueControlToken({
        action: "end-room",
        roomId: ROOM_ID,
        authGeneration: 1,
        issuedAtSeconds: nowSeconds(),
      }),
    });
    await waitUntil(
      () => oldGeneration.connectionState().status === "disconnected",
      "generation 1 to be closed",
    );
    expect(newGeneration.connectionState().status).toBe("connected");
  });

  it("refuses a reconnect that replays a token minted before the revocation", async () => {
    const server = await startServer();
    // The revoked member keeps the token their browser already holds.
    const staleToken = issueJoinToken({
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      subject: "user-guest",
      // Issued under the revision that the revocation below supersedes; the
      // wall clock still has to be real, or the relay rejects it as unexpired.
      authRevision: 1,
      issuedAtSeconds: nowSeconds(),
    });
    const guest = createTestClient({
      url: server.url,
      roomId: ROOM_ID,
      clientId: CLIENT_B,
      nonceSeed: 2,
      subject: "user-guest",
      joinToken: staleToken,
    });
    cleanups.push(() => guest.close());
    await guest.connect();

    await postControl(server, {
      token: issueControlToken({
        action: "revoke-member",
        roomId: ROOM_ID,
        subject: "user-guest",
        authRevision: 2,
        issuedAtSeconds: nowSeconds(),
      }),
    });
    await waitUntil(
      () => guest.connectionState().status === "disconnected",
      "revoked member to be disconnected",
    );

    // Closing the socket alone would leave the revocation bypassable for the
    // rest of the token's lifetime, so the rejoin must be refused as well.
    const socket = await rawSocket(server.url);
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientId: CLIENT_B,
        token: staleToken,
      }),
    );
    expect(await closeCodeOf(socket)).toBe(RELAY_CLOSE_CODES.membershipRevoked);
    expect(server.sessionCount()).toBe(0);
  });

  it("closes a session whose membership is revoked right after the token was minted", async () => {
    const server = await startServer();
    // Time-of-check/time-of-use: the app issued a valid token, the member
    // joined, and only then was the membership revoked. The join itself cannot
    // be refused retroactively, so the socket must be closed instead.
    const guest = client(server.url, CLIENT_B, 2, { subject: "user-guest" });
    await guest.connect();
    expect(guest.connectionState().status).toBe("connected");

    await postControl(server, {
      token: issueControlToken({
        action: "revoke-member",
        roomId: ROOM_ID,
        subject: "user-guest",
        issuedAtSeconds: nowSeconds(),
      }),
    });
    await waitUntil(
      () => guest.connectionState().status === "disconnected",
      "revoked session to be closed",
    );
    expect(server.roomCount()).toBe(0);
  });

  it("rejects control calls that are not authorized, addressed, or shaped correctly", async () => {
    const server = await startServer();
    const a = client(server.url, CLIENT_A, 1, { subject: "user-a" });
    await a.connect();
    await waitUntil(() => server.sessionCount() === 1, "member to join");

    const forged = await postControl(server, {
      token: issueControlToken({
        action: "end-room",
        roomId: ROOM_ID,
        secret: "another-secret-long-enough-for-hmac-0123",
        issuedAtSeconds: nowSeconds(),
      }),
    });
    expect(forged.status).toBe(401);

    const expired = await postControl(server, {
      token: issueControlToken({
        action: "end-room",
        roomId: ROOM_ID,
        issuedAtSeconds: nowSeconds() - 3_600,
        ttlSeconds: 30,
      }),
    });
    expect(expired.status).toBe(401);

    // A join token is not a control token, even though both are signed.
    const wrongAudience = await postControl(server, {
      token: issueJoinToken({
        roomId: ROOM_ID,
        clientId: CLIENT_A,
        issuedAtSeconds: nowSeconds(),
      }),
    });
    expect(wrongAudience.status).toBe(401);

    expect((await postControl(server, "not json")).status).toBe(400);
    expect((await postControl(server, { token: "" })).status).toBe(400);
    expect(
      (
        await postControl(server, {
          token: "x".repeat(MAX_ROOM_TOKEN_BYTES + 4_096),
        })
      ).status,
    ).toBe(413);

    const notFound = await fetch(`${server.controlUrl}/nope`, {
      method: "POST",
      body: "{}",
    });
    expect(notFound.status).toBe(404);
    const wrongMethod = await fetch(
      `${server.controlUrl}${RELAY_CONTROL_PATH}`,
    );
    expect(wrongMethod.status).toBe(405);

    // Every rejected call left the authorized session alone.
    expect(a.connectionState().status).toBe("connected");
    expect(server.sessionCount()).toBe(1);
  });
});
