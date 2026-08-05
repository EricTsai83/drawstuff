import { afterEach, describe, expect, it } from "vitest";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import { createSeededRandom } from "@drawstuff/collaboration/testing";
import type { DisconnectReason } from "@drawstuff/collaboration/transport";

import { RELAY_CONTROL_PATH } from "../src/control.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import {
  issueControlToken,
  TEST_ROOM_TOKEN_SECRET,
} from "./support/room-tokens.ts";
import { createFaultySocketFactory } from "./support/faulty-socket.ts";
import {
  createTestClient,
  waitUntil,
  type TestClient,
} from "./support/test-client.ts";

/**
 * Plan 18 over a real socket.
 *
 * Two kinds of fault are injected here, and both are injected against the real
 * relay rather than a model of it.
 *
 * The first is closing connections — a restart, a revoked authorization, an ended
 * room — which is what a real relay actually does to a session. What that
 * establishes is the half no in-process suite can: that the close carries the
 * reason recovery decides from, and that clients holding divergent state converge
 * after a genuine socket teardown and rejoin.
 *
 * The second is delivery faults — drop, duplicate, reorder — injected at the
 * client's socket boundary (`./support/faulty-socket.ts`). The deterministic suite
 * covers the fault *space* far more cheaply, so the reason to repeat them here is
 * what it cannot reach: these faults act on real sealed relay data frames, and an
 * injected duplicate is fanned out twice by the relay while a reordered frame is
 * fanned out in the order the relay received it. So framing, encryption, buffering
 * and fanout are all in the path being tested.
 */

const ROOM_ID = roomIdSchema.parse("room-reconnect");
const CLIENT_A = clientIdSchema.parse("client-a");
const CLIENT_B = clientIdSchema.parse("client-b");
const SUBJECT_A = "user-a";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startServer(port = 0): Promise<RelayServer> {
  const server = await createRelayServer({
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
    port,
  });
  cleanups.push(() => server.close());
  return server;
}

async function client(
  url: string,
  clientId: typeof CLIENT_A,
  nonceSeed: number,
  overrides: {
    subject?: string;
    createSocket?: Parameters<typeof createTestClient>[0]["createSocket"];
  } = {},
): Promise<TestClient> {
  const testClient = await createTestClient({
    url,
    roomId: ROOM_ID,
    clientId,
    nonceSeed,
    ...overrides,
  });
  cleanups.push(() => testClient.close());
  return testClient;
}

const disconnectReasonOf = (target: TestClient): DisconnectReason => {
  const state = target.connectionState();
  if (state.status !== "disconnected") {
    throw new Error(`expected a disconnected client, got "${state.status}"`);
  }
  return state.reason;
};

const postControl = async (
  server: RelayServer,
  token: string,
): Promise<number> => {
  const response = await fetch(`${server.controlUrl}${RELAY_CONTROL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await response.text();
  return response.status;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("reconnect and convergence over the relay", () => {
  it("converges after a relay restart with edits made on both sides while down", async () => {
    const first = await startServer();
    const port = first.port;
    const a = await client(first.url, CLIENT_A, 1);
    const b = await client(first.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("before-restart", "from-a");
    await waitUntil(
      () => b.elementIds().includes("before-restart"),
      "the pre-restart element to reach b",
    );
    const generationBefore = a.roomGeneration();

    // The relay keeps no scene state and no persistence, so a restart is a pure
    // connection fault: every member is dropped and nothing is replayed.
    await first.close();
    await a.waitForDisconnect();
    await b.waitForDisconnect();

    // Nothing about a restart says "stop trying", and that is exactly what the
    // close has to convey — a terminal reason here would strand every member.
    expect(disconnectReasonOf(a)).toBe("transient");
    expect(disconnectReasonOf(b)).toBe("transient");

    // Both sides keep drawing while the relay is gone.
    a.upsertElement("offline-a", "from-a");
    b.upsertElement("offline-b", "from-b");

    const second = await startServer(port);
    await a.connect();
    await b.connect();

    // A restarted relay starts a fresh room epoch. Both members adopt it from
    // their own `joined` acknowledgment; a client still stamping the old epoch
    // would have every frame rejected by the other's inbound gate.
    expect(a.roomGeneration()).toBeGreaterThan(generationBefore ?? 0);
    expect(b.roomGeneration()).toBe(a.roomGeneration());
    expect(second.roomCount()).toBe(1);

    await waitUntil(
      () => a.digest() === b.digest(),
      "both clients to converge after the restart",
    );
    // Convergence on the union, not on one side's view: the snapshot exchange
    // after a rejoin has to carry what each side did while it was alone.
    expect(a.elementIds()).toEqual([
      "before-restart",
      "offline-a",
      "offline-b",
    ]);
  });

  it("reports a withdrawn authorization as `membership-revoked`", async () => {
    const server = await startServer();
    const a = await client(server.url, CLIENT_A, 1, { subject: SUBJECT_A });
    await a.connect();

    expect(
      await postControl(
        server,
        issueControlToken({
          action: "revoke-member",
          roomId: ROOM_ID,
          subject: SUBJECT_A,
          issuedAtSeconds: nowSeconds(),
        }),
      ),
    ).toBe(200);

    await a.waitForDisconnect();
    // Distinguished from a transient close, but deliberately *not* terminal: the
    // app sends this same control action to force a reconnect after a role change,
    // so only the next token request can tell a demotion from a removal. What
    // matters here is that the reason arrives intact for that policy to act on.
    expect(disconnectReasonOf(a)).toBe("membership-revoked");
  });

  it("reports an ended room generation as terminal", async () => {
    const server = await startServer();
    const a = await client(server.url, CLIENT_A, 1);
    await a.connect();

    expect(
      await postControl(
        server,
        issueControlToken({
          action: "end-room",
          roomId: ROOM_ID,
          issuedAtSeconds: nowSeconds(),
        }),
      ),
    ).toBe(200);

    await a.waitForDisconnect();
    expect(disconnectReasonOf(a)).toBe("room-ended");
  });

  /**
   * Faults installed on the client's socket, replayed from a fixed seed. Only
   * outbound is faulted: an outbound drop means the relay never receives the
   * frame, and an outbound duplicate or reorder is fanned out by the relay exactly
   * as it arrived — so every fault is observed on the far side of the real routing
   * path rather than short-circuited before it.
   */
  const FAULT_SEEDS = [11, 20260805];

  for (const seed of FAULT_SEEDS) {
    it(`converges through the relay under dropped, duplicated and reordered frames (seed ${seed})`, async () => {
      const server = await startServer();
      const { createSocket, controller } = createFaultySocketFactory({
        random: createSeededRandom(seed),
      });
      const faulty = await client(server.url, CLIENT_A, 1, { createSocket });
      const clean = await client(server.url, CLIENT_B, 2);
      await faulty.connect();
      await clean.connect();

      controller.setFaults({
        dropProbability: 0.4,
        duplicateProbability: 0.3,
        reorderProbability: 0.3,
        direction: "outbound",
      });
      // Enough frames that all three faults fire on any seed rather than only on
      // lucky ones. Each fault is an independent per-frame draw, so a dozen frames
      // leaves a real chance of never duplicating anything — and a case that
      // silently skipped a fault would report convergence it never tested.
      const created = Array.from({ length: 60 }, (_, index) => `el-${index}`);
      for (const id of created) faulty.upsertElement(id, `v-${id}`);

      // Sealing is asynchronous — the transport reserves nonces in send order and
      // hands the frames to the socket from a promise chain — so the frames have
      // not reached the socket yet. Waiting on the counters rather than on a sleep
      // is what keeps this deterministic; the assertions below then name exactly
      // which fault failed to happen if one did.
      const allFaultsFired = (): boolean =>
        controller.droppedCount > 0 &&
        controller.duplicatedCount > 0 &&
        controller.reorderedCount > 0;
      await waitUntil(allFaultsFired, "every injected fault to fire").catch(
        () => undefined,
      );
      expect(controller.droppedCount).toBeGreaterThan(0);
      expect(controller.duplicatedCount).toBeGreaterThan(0);
      expect(controller.reorderedCount).toBeGreaterThan(0);

      controller.setFaults();
      controller.releaseHeldFrames();

      // One more edit, and then nothing: convergence has to come from the clients'
      // own repair moves over the real socket — the snapshot exchange that a
      // sequence gap and a received snapshot each trigger.
      faulty.upsertElement("final", "v-final");
      await waitUntil(
        () => faulty.digest() === clean.digest(),
        `clients to converge through relay faults (seed ${seed})`,
      );
      // Drops must not have left holes and duplicates must not have been applied
      // twice: both sides end on exactly the element set that was created.
      expect(clean.elementIds()).toEqual([...created, "final"].sort());
    });
  }

  it("keeps a rejoining client's session-ordered sequences from colliding", async () => {
    const server = await startServer();
    const a = await client(server.url, CLIENT_A, 1);
    const b = await client(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();

    a.upsertElement("el-1", "v1");
    await waitUntil(
      () => b.elementIds().includes("el-1"),
      "the first element to reach b",
    );

    // A reconnect is a new peer session, so its sequence starts at 1 again. The
    // receiver must not read that as a stale duplicate of the old session's
    // sequence 1 — which is why the gate keys on peer id, and why a reconnect
    // gets a new one.
    a.disconnect();
    await a.waitForDisconnect();
    expect(disconnectReasonOf(a)).toBe("idle");
    await a.connect();

    a.upsertElement("el-2", "v1");
    await waitUntil(
      () => b.elementIds().includes("el-2"),
      "the post-reconnect element to reach b",
    );
    await waitUntil(
      () => a.digest() === b.digest(),
      "both clients to converge after the rejoin",
    );
  });
});
