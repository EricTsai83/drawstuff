import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import { RELAY_CONTROL_PATH } from "../src/control.ts";
import { createInMemoryRoomFanout, type RoomFanout } from "../src/fanout.ts";
import { RELAY_HEALTH_PATH, RELAY_METRICS_PATH } from "../src/monitoring.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import {
  ALLOWED_LOG_FIELDS,
  createTestLogger,
  type TestLogger,
} from "./support/observability.ts";
import {
  issueControlToken,
  issueJoinToken,
  TEST_ROOM_TOKEN_SECRET,
} from "./support/room-tokens.ts";
import {
  createTestClient,
  TEST_ROOM_KEY,
  waitUntil,
  type TestClient,
} from "./support/test-client.ts";

/**
 * Plan 24 over the real server: metrics, health and structured logs observed
 * through a genuine session rather than through the units that produce them.
 *
 * The reason this has to be an integration test is the data-classification half.
 * The threat model's forbidden list is about what leaves the process, so the only
 * assertion that means anything is one made against the actual exposition and the
 * actual log lines produced while real sealed frames, a real join token and a real
 * presence payload were in scope.
 */

const ROOM_ID = roomIdSchema.parse("room-observability");
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const SUBJECT_A = "user-observability-a";
/** Presence carries this; the relay must never be able to write it down. */
const USERNAME_A = "Ada Lovelace";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

type Started = {
  server: RelayServer;
  logs: TestLogger;
  /** Every frame the relay routed, so ciphertext can be searched for by value. */
  routed: Uint8Array[];
};

async function startServer(
  options: { logFrames?: boolean } = {},
): Promise<Started> {
  const logs = createTestLogger({ logFrames: options.logFrames });
  const inner = createInMemoryRoomFanout();
  const routedFrames: Uint8Array[] = [];
  const fanout: RoomFanout = {
    ...inner,
    publish(channel, senderPeerId, messageChannel, frame) {
      routedFrames.push(Uint8Array.from(frame));
      return inner.publish(channel, senderPeerId, messageChannel, frame);
    },
  };
  const server = await createRelayServer({
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
    logger: logs.logger,
    fanout,
  });
  cleanups.push(() => server.close());
  return { server, logs, routed: routedFrames };
}

async function client(
  url: string,
  clientName: string,
  nonceSeed: number,
  overrides: {
    role?: "owner" | "editor" | "viewer";
    subject?: string;
    username?: string;
  } = {},
): Promise<TestClient> {
  const testClient = await createTestClient({
    url,
    roomId: ROOM_ID,
    clientName,
    nonceSeed,
    ...overrides,
  });
  cleanups.push(() => testClient.close());
  return testClient;
}

const scrape = async (
  server: RelayServer,
  path: string,
): Promise<{ status: number; contentType: string | null; body: string }> => {
  const response = await fetch(`${server.controlUrl}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
};

const sample = (exposition: string, selector: string): number | undefined => {
  const line = exposition
    .split("\n")
    .find((candidate) => candidate.startsWith(`${selector} `));
  return line === undefined
    ? undefined
    : Number(line.slice(selector.length + 1));
};

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const openRawSocket = async (url: string): Promise<WsClient> => {
  const socket = new WsClient(url);
  cleanups.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
};

/**
 * A viewer that drives the transport itself, which is the only way to reach the
 * relay's own role check: the collaboration client refuses a read-only mutation
 * before it ever becomes a frame.
 */
const joinRawViewer = async (
  server: RelayServer,
): Promise<{ publishSceneFrame(): Promise<number> }> => {
  const socket = await openRawSocket(server.url);
  socket.send(
    encodeRelayControl({
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: ROOM_ID,
      token: issueJoinToken({
        roomId: ROOM_ID,
        role: "viewer",
        subject: SUBJECT_A,
        issuedAtSeconds: Math.floor(Date.now() / 1000),
      }),
    }),
  );
  await waitUntil(() => server.sessionCount() >= 1, "the viewer to join");
  return {
    async publishSceneFrame() {
      const closed = new Promise<number>((resolve) =>
        socket.once("close", (code) => resolve(code)),
      );
      // A hand-built scene data frame: the relay decides on the channel byte
      // alone, with no cooperation from the client.
      socket.send(new Uint8Array([0x01, 0x7b, 0x7d]));
      return closed;
    },
  };
};

describe("relay observability endpoints", () => {
  it("serves health without authorization and reports only a status", async () => {
    const { server } = await startServer();
    const healthy = await scrape(server, RELAY_HEALTH_PATH);

    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.body)).toEqual({ status: "ok" });
    // Status only: capacity numbers here would invite a load balancer to treat a
    // busy-but-healthy relay as failed.
    expect(healthy.body).not.toContain("connections");
  });

  it("reports unhealthy while draining", async () => {
    const { server, logs } = await startServer();
    expect((await scrape(server, RELAY_HEALTH_PATH)).status).toBe(200);

    server.beginDrain();
    const draining = await scrape(server, RELAY_HEALTH_PATH);

    // 503, so a rolling restart can hand traffic over before this instance stops
    // accepting it (Plan 25 owns the connection half of that handover).
    expect(draining.status).toBe(503);
    expect(JSON.parse(draining.body)).toEqual({ status: "draining" });
    expect(sample(server.renderMetrics(), "relay_draining")).toBe(1);
    expect(logs.recordsOf("relay.draining")).toHaveLength(1);

    // Idempotent: a second drain signal is not a second transition.
    server.beginDrain();
    expect(logs.recordsOf("relay.draining")).toHaveLength(1);
  });

  it("enters the draining state on shutdown without an explicit drain", async () => {
    // `close()` flips the state before it stops listening, so a probe that lands
    // during shutdown gets 503 rather than a healthy answer from a process that
    // is going away. Asserted on the state rather than on a racing fetch.
    const { server } = await startServer();
    expect(sample(server.renderMetrics(), "relay_draining")).toBe(0);
    await server.close();
    expect(sample(server.renderMetrics(), "relay_draining")).toBe(1);
  });

  it("refuses non-read methods on both monitoring paths", async () => {
    const { server } = await startServer();
    for (const path of [RELAY_METRICS_PATH, RELAY_HEALTH_PATH]) {
      const response = await fetch(`${server.controlUrl}${path}`, {
        method: "POST",
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      await response.text();
    }
  });

  it("does not shadow the control endpoint", async () => {
    const { server } = await startServer();
    const response = await fetch(`${server.controlUrl}${RELAY_CONTROL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: issueControlToken({
          action: "end-room",
          roomId: ROOM_ID,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(
      sample(
        server.renderMetrics(),
        'relay_control_requests_total{outcome="applied"}',
      ),
    ).toBe(1);
  });
});

describe("relay metrics from a real session", () => {
  it("measures capacity, traffic and routing latency", async () => {
    const { server } = await startServer();
    const a = await client(server.url, CLIENT_A, 1, { subject: SUBJECT_A });
    const b = await client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("el-1", "observed");
    a.sendPresence(4, 8);
    await waitUntil(
      () => b.elementIds().includes("el-1") && b.presenceReceived().length > 0,
      "the frame and the presence sample to arrive",
    );

    const metrics = await scrape(server, RELAY_METRICS_PATH);
    expect(metrics.status).toBe(200);
    expect(metrics.contentType).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );

    expect(sample(metrics.body, "relay_connections")).toBe(2);
    expect(sample(metrics.body, "relay_rooms")).toBe(1);
    expect(sample(metrics.body, "relay_sessions")).toBe(2);
    expect(
      sample(metrics.body, 'relay_rooms_by_member_count{members="2"}'),
    ).toBe(1);
    expect(sample(metrics.body, "relay_room_members_max")).toBe(2);
    expect(sample(metrics.body, "relay_joins_total")).toBe(2);

    const sceneRouted = sample(
      metrics.body,
      'relay_frames_routed_total{channel="scene"}',
    );
    expect(sceneRouted).toBeGreaterThan(0);
    expect(
      sample(metrics.body, 'relay_frames_routed_total{channel="presence"}'),
    ).toBe(1);
    expect(
      sample(metrics.body, 'relay_routed_bytes_total{channel="scene"}'),
    ).toBeGreaterThan(0);
    expect(
      sample(metrics.body, 'relay_frames_delivered_total{channel="scene"}'),
    ).toBeGreaterThan(0);

    // SLO §3.1 is only measurable for a publish that had recipients, so the
    // sample count trails the routed count by the frames a lone first member
    // sent before anyone else was there.
    const latencyCount = sample(
      metrics.body,
      "relay_routing_latency_seconds_count",
    );
    expect(latencyCount).toBeGreaterThan(0);
    expect(latencyCount).toBeLessThanOrEqual((sceneRouted ?? 0) + 1);
    // Every sample is inside the p99 threshold; an in-process fanout has no I/O.
    expect(
      sample(metrics.body, 'relay_routing_latency_seconds_bucket{le="0.02"}'),
    ).toBe(latencyCount);

    expect(
      sample(metrics.body, "relay_process_resident_memory_bytes"),
    ).toBeGreaterThan(0);
  });

  it("does not time a publish that reached nobody", async () => {
    // A lone member's frames do no fanout work, so timing them would report the
    // relay's fastest case for a room that has no routing to do.
    const { server } = await startServer();
    const a = await client(server.url, CLIENT_A, 1);
    await a.connect();
    a.upsertElement("el-alone", "no recipients");
    await waitUntil(
      () =>
        (sample(
          server.renderMetrics(),
          'relay_frames_routed_total{channel="scene"}',
        ) ?? 0) > 0,
      "the frame to be routed",
    );

    expect(
      sample(server.renderMetrics(), "relay_routing_latency_seconds_count"),
    ).toBe(0);
  });

  it("does not time a publish whose recipient was skipped", async () => {
    // SLO §3.1 is "handed to every other member's send". A presence frame dropped
    // for backpressure never reaches a send, and skipping it is cheaper than
    // performing it — so counting that publish would make the histogram look
    // faster precisely when the relay is under load. The drop stays visible in
    // `relay_presence_frames_dropped_total`.
    const logs = createTestLogger();
    const inner = createInMemoryRoomFanout();
    const droppingFanout: RoomFanout = {
      ...inner,
      publish(channel, senderPeerId, messageChannel, frame) {
        const routed = inner.publish(
          channel,
          senderPeerId,
          messageChannel,
          frame,
        );
        // Every recipient was intended; none of them accepted.
        return { intended: routed.intended, delivered: 0 };
      },
    };
    const server = await createRelayServer({
      joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
      logger: logs.logger,
      fanout: droppingFanout,
    });
    cleanups.push(() => server.close());

    const a = await client(server.url, CLIENT_A, 1);
    const b = await client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("el-skipped", "never handed to a send");
    await waitUntil(
      () =>
        (sample(
          server.renderMetrics(),
          'relay_frames_routed_total{channel="scene"}',
        ) ?? 0) > 0,
      "the frame to be routed",
    );

    expect(
      sample(server.renderMetrics(), "relay_routing_latency_seconds_count"),
    ).toBe(0);
  });

  it("counts each disconnect under its own close code", async () => {
    const { server } = await startServer();
    // A viewer that bypasses the client and publishes anyway is refused with its
    // own close code, which must not be folded into a generic protocol error.
    const viewer = await joinRawViewer(server);
    await viewer.publishSceneFrame();

    const leaver = await client(server.url, CLIENT_B, 2);
    await leaver.connect();
    leaver.disconnect();

    await waitUntil(
      () => server.connectionCount() === 0,
      "both sockets to be released",
    );
    const exposition = server.renderMetrics();
    expect(
      sample(
        exposition,
        'relay_connections_closed_total{reason="readOnlyRole"}',
      ),
    ).toBe(1);
    expect(
      sample(
        exposition,
        'relay_connections_closed_total{reason="normalClosure"}',
      ),
    ).toBe(1);
    expect(
      sample(
        exposition,
        'relay_connections_closed_total{reason="protocolViolation"}',
      ),
    ).toBe(0);
    expect(sample(exposition, "relay_connections_opened_total")).toBe(2);
  });

  it("counts a peer that vanishes apart from a relay-initiated close", async () => {
    const { server } = await startServer();
    const socket = new WsClient(server.url);
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomId: ROOM_ID,
        token: issueJoinToken({
          roomId: ROOM_ID,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
      }),
    );
    await waitUntil(() => server.sessionCount() === 1, "the socket to join");
    socket.terminate();

    await waitUntil(
      () => server.connectionCount() === 0,
      "the socket to be released",
    );
    expect(
      sample(
        server.renderMetrics(),
        'relay_connections_closed_total{reason="peerClosed"}',
      ),
    ).toBe(1);
  });
});

describe("relay telemetry data classification", () => {
  it("keeps keys, ciphertext, tokens and presence data out of logs and metrics", async () => {
    // Per-frame logging on, which is the noisiest configuration the relay has:
    // if the forbidden list survives this, it survives every quieter one.
    const { server, logs, routed } = await startServer({ logFrames: true });
    const joinToken = issueJoinToken({
      roomId: ROOM_ID,
      subject: SUBJECT_A,
      issuedAtSeconds: Math.floor(Date.now() / 1000),
    });
    const a = await createTestClient({
      url: server.url,
      roomId: ROOM_ID,
      clientName: CLIENT_A,
      nonceSeed: 1,
      subject: SUBJECT_A,
      username: USERNAME_A,
      joinToken,
    });
    cleanups.push(() => a.close());
    const b = await client(server.url, CLIENT_B, 2, { username: "Grace H" });
    await a.connect();
    await b.connect();
    a.upsertElement("el-secret", "plaintext-never-leaves-the-browser");
    a.sendPresence(1, 2);
    await waitUntil(
      () => b.elementIds().includes("el-secret") && routed.length > 2,
      "sealed frames to be routed",
    );

    const exposition = server.renderMetrics();
    const logOutput = logs.lines().join("");
    const surfaces = { logs: logOutput, metrics: exposition };

    for (const [surface, text] of Object.entries(surfaces)) {
      // Room key and derived key material.
      expect(text, surface).not.toContain(TEST_ROOM_KEY);
      // Tokens, whole or in fragments: a 16-character slice of a signed token is
      // still a token fragment.
      expect(text, surface).not.toContain(joinToken);
      expect(text, surface).not.toContain(joinToken.slice(0, 16));
      // Ciphertext bodies, searched for by the exact bytes the relay routed.
      for (const frame of routed) {
        expect(text, surface).not.toContain(base64(frame));
        expect(text, surface).not.toContain(base64(frame.subarray(1)));
      }
      // Presence `username` is user data even though the relay cannot read it.
      expect(text, surface).not.toContain(USERNAME_A);
      expect(text, surface).not.toContain("Grace H");
      // Scene plaintext.
      expect(text, surface).not.toContain("plaintext-never-leaves-the-browser");
      expect(text, surface).not.toContain("el-secret");
      // The raw authenticated subject.
      expect(text, surface).not.toContain(SUBJECT_A);
    }

    // The exposition additionally carries no room-scoped identifier at all, so a
    // scrape cannot enumerate rooms or members.
    expect(exposition).not.toContain(ROOM_ID);

    // What the logs *do* carry: relay-generated or token-verified fields only —
    // the app's identifiers, the relay's own peer id, and a pseudonym in place
    // of the authenticated subject.
    const join = logs.recordsOf("relay.join")[0];
    expect(join).toMatchObject({
      roomId: ROOM_ID,
      authGeneration: 1,
      role: "editor",
    });
    expect(typeof join?.peerId).toBe("string");
    expect(join?.subject).toBe(logs.logger.pseudonym(SUBJECT_A));
    expect(logs.recordsOf("relay.frame").length).toBeGreaterThan(0);
    expect(logs.recordsOf("relay.frame")[0]).toMatchObject({
      channel: "scene",
    });
  });

  it("emits no log field outside the classified allowlist", async () => {
    // The field type is a compile-time allowlist; this is the runtime half, so a
    // record assembled by spreading an object cannot smuggle a field past it.
    const { server, logs } = await startServer({ logFrames: true });
    const a = await client(server.url, CLIENT_B, 2, { subject: SUBJECT_A });
    await a.connect();
    a.upsertElement("el-1", "observed");
    const viewer = await joinRawViewer(server);
    await viewer.publishSceneFrame();
    server.beginDrain();
    await fetch(`${server.controlUrl}${RELAY_CONTROL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-token" }),
    }).then((response) => response.text());

    const unexpected = new Set<string>();
    for (const record of logs.records()) {
      for (const field of Object.keys(record)) {
        if (!ALLOWED_LOG_FIELDS.includes(field)) unexpected.add(field);
      }
    }
    expect([...unexpected]).toEqual([]);
    // The run really did exercise the paths that log the most.
    expect(
      [...new Set(logs.records().map((record) => record.event))].sort(),
    ).toEqual([
      "relay.connection_closed",
      "relay.control",
      "relay.draining",
      "relay.frame",
      "relay.join",
    ]);
  });

  it("logs no identifier a client chose before its token bound them", async () => {
    // `roomIdSchema` accepts 1-64 base64url characters, and a room key is 43
    // characters from the same alphabet — so a room key is a *valid* room id.
    // A client can therefore put key material in the field and force a
    // verification failure to get it written to the relay's log, unless the
    // refusal path logs no client-chosen identifier at all.
    const { server, logs } = await startServer();
    const socket = await openRawSocket(server.url);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        // The room key, verbatim, as the room id.
        roomId: roomIdSchema.parse(TEST_ROOM_KEY),
        token: issueJoinToken({
          roomId: ROOM_ID,
          issuedAtSeconds: Math.floor(Date.now() / 1000),
        }),
      }),
    );

    expect(await closed).toBe(RELAY_CLOSE_CODES.unauthorized);
    const refusal = logs.recordsOf("relay.join_refused")[0];
    expect(refusal).toMatchObject({ tokenFailure: "wrong-room" });
    expect(refusal).not.toHaveProperty("roomId");
    expect(logs.lines().join("")).not.toContain(TEST_ROOM_KEY);
    expect(server.renderMetrics()).not.toContain(TEST_ROOM_KEY);
  });

  it("records a refused join by its enumerated reason, never by token content", async () => {
    const { server, logs } = await startServer();
    const socket = new WsClient(server.url);
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const forged = `${issueJoinToken({
      roomId: ROOM_ID,
      issuedAtSeconds: Math.floor(Date.now() / 1000),
    })}tampered`;
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomId: ROOM_ID,
        token: forged,
      }),
    );

    expect(await closed).toBe(RELAY_CLOSE_CODES.unauthorized);
    const refusal = logs.recordsOf("relay.join_refused")[0];
    expect(refusal).toMatchObject({ tokenFailure: "bad-signature" });
    expect(logs.lines().join("")).not.toContain(forged.slice(0, 16));
  });
});
