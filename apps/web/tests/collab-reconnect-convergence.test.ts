import { beforeEach, describe, expect, it } from "vitest";

import type {
  CollaborationMessage,
  SceneMessage,
  SyncedElement,
} from "@drawstuff/collaboration/protocol";
import { createSeededRandom } from "@drawstuff/collaboration/testing";
import type {
  CollaborationTransport,
  TransportSubscriber,
} from "@drawstuff/collaboration/transport";
import type { OrderedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

import { FULL_SCENE_SYNC_INTERVAL_MS } from "@/lib/collab/collaboration-session";
import {
  collabRectangle,
  editedElement,
} from "./support/collab-scene-fixtures";

import {
  createHarness,
  createSnapshotBackend,
  peerIdOf,
  ROOM_ID,
  type TestClient,
} from "./support/collab-session-harness";

/**
 * Plan 18: reconnect and convergence.
 *
 * Two things are established here, and they are different in kind.
 *
 * The first is the recovery state machine as the session actually drives it:
 * which disconnects reconnect, which ones stop and say why, what a rejoin
 * publishes, and that nothing — timer, socket, or buffer — outlives a terminal
 * state.
 *
 * The second is convergence under injected faults. Every scenario ends by
 * comparing the *complete* scene of every client, and nothing waits on wall time:
 * the network is stepped explicitly, and healing is driven by the session's own
 * periodic full sync against a manual clock. A fault matrix runs on seeded
 * randomness, so a failure is replayed by its seed rather than reproduced by luck.
 */

/**
 * Deterministic backoff: half the base delay, so one `advance` past it always
 * fires the retry regardless of jitter.
 */
const TEST_RECOVERY = {
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxAttempts: 3,
  random: () => 0,
  // These tests state live lifetimes with a clock that only moves when a test
  // moves it, so a non-zero window would count every synced session as
  // short-lived. Zero keeps "any resolved baseline clears the budget"; the
  // live-stability behavior has its own test below.
  liveStabilityMs: 0,
} as const;

/** Comfortably past any scheduled retry in these tests. */
const PAST_EVERY_TIMER_MS = 10_000;

/**
 * A fake-network transport that can also deliver `onRoomUnreadable`.
 *
 * The fake network carries plaintext on purpose (see `testing.ts`), so it can
 * never produce the failed decryptions this verdict is derived from. Injecting
 * the verdict is the honest split: whether the transport reaches it from three
 * unopenable frames is settled against real Web Crypto in
 * `packages/collaboration/tests/relay-client.test.ts`; what the *session* does
 * with it is settled here.
 */
function transportWithUnreadableProbe(inner: CollaborationTransport): {
  transport: CollaborationTransport;
  reportRoomUnreadable: () => void;
} {
  const subscribers = new Set<TransportSubscriber>();
  return {
    transport: {
      ...inner,
      subscribe(subscriber) {
        subscribers.add(subscriber);
        const unsubscribe = inner.subscribe(subscriber);
        return () => {
          subscribers.delete(subscriber);
          unsubscribe();
        };
      },
    },
    reportRoomUnreadable() {
      for (const subscriber of subscribers) subscriber.onRoomUnreadable?.();
    },
  };
}

/**
 * Complete scene of one client, as a comparable string.
 *
 * Every field is included, not just the identity triple: convergence means the
 * clients hold the same scene, and a digest that only compared versions would
 * pass while two clients disagreed about what an element looks like.
 *
 * Element order is preserved, because it *is* scene state — the array order is
 * the stacking order the canvas renders. Sorting the elements first would have
 * made two clients holding the same elements in different render orders compare
 * equal, which is precisely a divergence this suite exists to catch.
 *
 * Property order, by contrast, is not scene state: an element that travelled over
 * the wire carries the key order of whoever created it, so a plain
 * `JSON.stringify` would report identical scenes as divergent purely because one
 * client drew the element and the other received it. So keys are canonicalized
 * and elements are not.
 */
const sceneDigest = (client: TestClient): string =>
  JSON.stringify(
    client.host.elements.map((element) =>
      Object.fromEntries(
        Object.entries(element as unknown as Record<string, unknown>).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      ),
    ),
  );

const expectAllConverged = (clients: readonly TestClient[]): void => {
  const digests = clients.map(sceneDigest);
  for (const [index, digest] of digests.entries()) {
    expect(digest, `client ${index} diverged`).toBe(digests[0]);
  }
  // A suite where every client converged on nothing proves nothing.
  expect(clients[0]?.host.elements.length ?? 0).toBeGreaterThan(0);
};

/** Records every message a client receives, without joining the room itself. */
const observe = (client: TestClient): CollaborationMessage[] => {
  const received: CollaborationMessage[] = [];
  client.transport.subscribe({
    onMessage: (message) => received.push(message),
  });
  return received;
};

const sceneMessages = (
  received: readonly CollaborationMessage[],
  senderPeerId?: string,
): SceneMessage[] =>
  received.filter(
    (message): message is SceneMessage =>
      message.type !== "presence" &&
      (senderPeerId === undefined || message.senderPeerId === senderPeerId),
  );

const idsOf = (message: SceneMessage): string[] =>
  message.payload.elements.map((element) => element.id).sort();

const rect = (id: string): OrderedExcalidrawElement => collabRectangle({ id });

describe("reconnect recovery", () => {
  let harness: ReturnType<typeof createHarness>;
  let alice: TestClient;
  let bob: TestClient;

  beforeEach(() => {
    harness = createHarness();
    alice = harness.createClient("client-alice", { recovery: TEST_RECOVERY });
    bob = harness.createClient("client-bob", { recovery: TEST_RECOVERY });
    alice.session.connect();
    bob.session.connect();
    harness.settle();
  });

  it("reports the recovery phases a join walks through", () => {
    const fresh = harness.createClient("client-fresh", {
      recovery: TEST_RECOVERY,
    });
    fresh.session.connect();
    harness.settle();

    expect(fresh.recoveryStates.map((state) => state.phase)).toEqual([
      "connecting",
      "syncing",
      "live",
    ]);
    expect(fresh.session.getRecoveryState()).toEqual({ phase: "live" });
  });

  it("reconnects with a freshly minted token after a transient drop", async () => {
    alice.edit((elements) => [...elements, rect("r1")]);
    harness.settle();

    harness.network.dropConnection(alice.transport);
    expect(alice.session.getRecoveryState()).toMatchObject({
      phase: "waiting",
      attempt: 1,
    });
    // Nothing is retried before the backoff elapses.
    expect(alice.tokenRefreshCount).toBe(0);

    await harness.advanceAndSettle([alice], PAST_EVERY_TIMER_MS);

    // The first token is spent; a reconnect must obtain its own, because tokens
    // are short-lived and because that request is where lost access is caught.
    expect(alice.tokenRefreshCount).toBe(1);
    expect(alice.session.getRecoveryState()).toEqual({ phase: "live" });
    expectAllConverged([alice, bob]);
  });

  it("publishes only the offline delta on a rejoin, not the whole scene", async () => {
    // A durable baseline that is current as of the disconnect, which is what a
    // rejoin normally finds: the room was persisted while this client was live.
    const backend = createSnapshotBackend();
    const rejoiner = harness.createClient("client-rejoiner", {
      recovery: TEST_RECOVERY,
      snapshotStore: backend.createStore(),
    });
    rejoiner.session.connect();
    await harness.drainMicrotasks();
    harness.settle();
    rejoiner.edit((elements) => [
      ...elements,
      rect("shared-1"),
      rect("shared-2"),
    ]);
    harness.settle();
    backend.publish(rejoiner.host.elements as unknown as SyncedElement[]);

    const seenByBob = observe(bob);
    harness.network.dropConnection(rejoiner.transport);
    // Two edits while offline: one new element and one revision of an existing.
    rejoiner.edit((elements) => [...elements, rect("offline-1")]);
    rejoiner.edit((elements) =>
      elements.map((element) =>
        element.id === "shared-1" ? editedElement(element) : element,
      ),
    );
    await harness.advanceAndSettle([rejoiner], PAST_EVERY_TIMER_MS);

    // A reconnect is a new relay session, so the rejoin publishes under the
    // fresh peerId the relay assigned to it.
    const published = sceneMessages(seenByBob, peerIdOf(rejoiner));
    // A delta, not a snapshot, and carrying exactly what the room was missing —
    // `shared-2` never changed and is not re-sent.
    expect(published[0]?.type).toBe("scene-update");
    expect(idsOf(published[0]!)).toEqual(["offline-1", "shared-1"]);
    // The elected peer's snapshot was built before that delta landed, so it
    // lacks the offline state and still draws one snapshot reply. That probe is
    // the repair path — a rejoiner cannot tell "your snapshot predates my delta"
    // from "my delta was lost" — so it is bounded, not eliminated.
    expect(
      published.filter((message) => message.type === "scene-init"),
    ).toHaveLength(1);
    expectAllConverged([alice, bob, rejoiner]);
  });

  it("replays an element deleted while offline as the tombstone it became", async () => {
    alice.edit((elements) => [...elements, rect("keep")]);
    harness.settle();

    harness.network.dropConnection(alice.transport);
    alice.edit((elements) => [...elements, rect("doomed")]);
    alice.edit((elements) =>
      elements.map((element) =>
        element.id === "doomed"
          ? editedElement(element, { isDeleted: true })
          : element,
      ),
    );
    await harness.advanceAndSettle([alice], PAST_EVERY_TIMER_MS);

    // The queue holds ids, not element bodies, so the reconnect re-reads the
    // scene: bob never sees the element alive.
    const doomed = bob.host.elements.find((element) => element.id === "doomed");
    expect(doomed?.isDeleted).toBe(true);
    expectAllConverged([alice, bob]);
  });

  it("falls back to one full-scene sync when the offline queue overflows", async () => {
    alice.edit((elements) => [...elements, rect("shared-1")]);
    harness.settle();
    const seenByBob = observe(bob);

    // A one-element budget: the second distinct offline change trips it.
    const tight = harness.createClient("client-tight", {
      recovery: TEST_RECOVERY,
      offlineQueue: { maxElements: 1 },
    });
    tight.session.connect();
    harness.settle();

    harness.network.dropConnection(tight.transport);
    tight.edit((elements) => [...elements, rect("burst-1")]);
    tight.edit((elements) => [...elements, rect("burst-2")]);
    await harness.advanceAndSettle([tight], PAST_EVERY_TIMER_MS);

    // The rejoin publish itself is the snapshot, rather than a delta followed by
    // a repair: one bounded full sync converges from any starting state.
    expect(sceneMessages(seenByBob, peerIdOf(tight))[0]?.type).toBe(
      "scene-init",
    );
    expectAllConverged([alice, bob, tight]);
  });

  it("falls back to one full-scene sync when the offline window ages out", async () => {
    const stale = harness.createClient("client-stale", {
      recovery: TEST_RECOVERY,
      offlineQueue: { maxAgeMs: 1_000 },
    });
    stale.session.connect();
    harness.settle();
    stale.edit((elements) => [...elements, rect("before")]);
    harness.settle();
    const seenByBob = observe(bob);

    harness.network.dropConnection(stale.transport);
    stale.edit((elements) => [...elements, rect("during")]);
    // Long enough offline that the peers who knew what this client had sent may
    // all be gone, which is exactly what a delta assumes and cannot check.
    harness.clock.now += 60_000;
    await harness.advanceAndSettle([stale], PAST_EVERY_TIMER_MS);

    expect(sceneMessages(seenByBob, peerIdOf(stale))[0]?.type).toBe(
      "scene-init",
    );
    expectAllConverged([alice, bob, stale]);
  });

  it("converges when both sides edited during the disconnect window", async () => {
    alice.edit((elements) => [...elements, rect("base")]);
    harness.settle();

    harness.network.dropConnection(alice.transport);
    alice.edit((elements) => [...elements, rect("from-alice")]);
    bob.edit((elements) => [...elements, rect("from-bob")]);
    harness.settle();

    await harness.advanceAndSettle([alice], PAST_EVERY_TIMER_MS);

    expect(alice.host.elements.map((element) => element.id).sort()).toEqual([
      "base",
      "from-alice",
      "from-bob",
    ]);
    expectAllConverged([alice, bob]);
  });

  it("reconnects every member after a relay restart and converges", async () => {
    alice.edit((elements) => [...elements, rect("pre-restart")]);
    harness.settle();
    const generationBefore = aliceGeneration(alice);

    harness.network.restartRoom(ROOM_ID);
    expect(alice.session.getRecoveryState()).toMatchObject({
      phase: "waiting",
    });
    expect(bob.session.getRecoveryState()).toMatchObject({ phase: "waiting" });

    await harness.advanceAndSettle([alice, bob], PAST_EVERY_TIMER_MS);

    expect(alice.session.getRecoveryState()).toEqual({ phase: "live" });
    expect(bob.session.getRecoveryState()).toEqual({ phase: "live" });
    // A restarted relay starts a new room epoch, and both members adopt it — a
    // client still stamping the old one would have every frame rejected.
    expect(aliceGeneration(alice)).toBeGreaterThan(generationBefore);
    expect(aliceGeneration(bob)).toBe(aliceGeneration(alice));
    expectAllConverged([alice, bob]);
  });

  it("heals a dropped final delta without any further editor activity", () => {
    alice.edit((elements) => [...elements, rect("delivered")]);
    harness.settle();

    // The last delta of a burst is lost, and then the room goes idle. This is the
    // one drop nothing reactive can repair: the sender has no acknowledgement to
    // miss, and the receiver sees no sequence gap because no later message ever
    // arrives. Only a timer the sender armed itself can close it.
    harness.network.setFaults({ dropProbability: 1 });
    alice.edit((elements) => [...elements, rect("dropped")]);
    harness.settle();
    harness.network.setFaults();
    expect(bob.host.elements.map((element) => element.id)).toEqual([
      "delivered",
    ]);

    // Nothing touches the canvas from here — only the clock moves.
    harness.clock.now += FULL_SCENE_SYNC_INTERVAL_MS;
    alice.timers.advance(FULL_SCENE_SYNC_INTERVAL_MS);
    alice.scheduler.runAll();
    harness.settle();

    expect(bob.host.elements.map((element) => element.id).sort()).toEqual([
      "delivered",
      "dropped",
    ]);
    expectAllConverged([alice, bob]);
  });

  it("bounds the repair budget so a silent room stops publishing", () => {
    const lonely = harness.createClient("client-lonely", {
      recovery: TEST_RECOVERY,
      maxSceneRepairAttempts: 2,
    });
    lonely.session.connect();
    harness.settle();
    lonely.edit((elements) => [...elements, rect("a")]);
    lonely.edit((elements) => [...elements, rect("b")]);
    harness.settle();
    // Re-armed rather than stacked: several publishes leave one pending repair.
    expect(lonely.timers.pendingCount).toBe(1);

    // Nobody ever answers. Each fired repair publishes a snapshot and arms the
    // next, until the budget is spent — the alternative would be a permanent
    // full-scene heartbeat from every member of every idle room.
    const published: number[] = [];
    const seenByAlice = observe(alice);
    for (let round = 0; round < 5; round += 1) {
      harness.clock.now += FULL_SCENE_SYNC_INTERVAL_MS;
      lonely.timers.advance(FULL_SCENE_SYNC_INTERVAL_MS);
      lonely.scheduler.runAll();
      // Delivered without letting anyone reply, so nothing counts as room
      // activity and the budget is never re-earned.
      harness.network.flush();
      published.push(
        sceneMessages(seenByAlice, peerIdOf(lonely)).filter(
          (message) => message.type === "scene-init",
        ).length,
      );
    }

    expect(lonely.timers.pendingCount).toBe(0);
    // Two repairs, then silence.
    expect(published.at(-1)).toBe(2);
  });

  it("spreads a reconnect storm instead of retrying in lockstep", () => {
    // Ten clients dropped at once. Equal-jitter backoff has to put them on
    // different milliseconds, or the relay comes back to a synchronized herd.
    const random = createSeededRandom(20260805);
    const storm = Array.from({ length: 10 }, (_, index) =>
      harness.createClient(`client-storm-${index}`, {
        recovery: { ...TEST_RECOVERY, maxDelayMs: 30_000, random },
      }),
    );
    for (const client of storm) client.session.connect();
    harness.settle(40);

    for (const client of storm)
      harness.network.dropConnection(client.transport);

    const delays = storm.map((client) => {
      const state = client.session.getRecoveryState();
      if (state.phase !== "waiting") throw new Error("expected waiting");
      return state.delayMs;
    });
    expect(new Set(delays).size).toBeGreaterThan(5);
    // And every one of them leaves the relay a real gap.
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(50);
  });
});

/** Room epoch of a connected client; a restart must move it forward. */
const aliceGeneration = (client: TestClient): number => {
  const state = client.session.getConnectionState();
  if (state.status !== "connected") throw new Error("expected connected");
  return state.roomGeneration;
};

describe("unrecoverable connection states", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("stops for good when the backend refuses to re-authorize", async () => {
    const client = harness.createClient("client-revoked", {
      recovery: TEST_RECOVERY,
      refreshJoinToken: () =>
        Promise.resolve({
          ok: false as const,
          retry: false as const,
          failure: "membership-revoked" as const,
        }),
    });
    client.session.connect();
    harness.settle();

    harness.network.dropConnection(client.transport);
    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);

    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "membership-revoked",
    });
    // Terminal means terminal: no timer is left armed and no further attempt is
    // made however long the test waits.
    expect(client.timers.pendingCount).toBe(0);
    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    expect(client.tokenRefreshCount).toBe(1);
  });

  it("reconnects through a revoked-membership close, because a role change is one", async () => {
    // The relay closes with `membership-revoked` whenever the app withdraws the
    // authorization a socket holds — and changing a member's role does exactly
    // that, on purpose, because the role travels in the token. Reading that close
    // as terminal would strand every demoted or promoted member in `failed`.
    const client = harness.createClient("client-role-changed", {
      recovery: TEST_RECOVERY,
    });
    client.session.connect();
    harness.settle();
    client.edit((elements) => [...elements, rect("before-role-change")]);
    harness.settle();

    harness.network.setDisconnectReason("membership-revoked");
    harness.network.dropConnection(client.transport);
    expect(client.session.getRecoveryState()).toMatchObject({
      phase: "waiting",
    });

    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    expect(client.session.getRecoveryState()).toEqual({ phase: "live" });
    expect(client.tokenRefreshCount).toBe(1);
  });

  it("stops with `room-ended` when the room ended while the client was offline", async () => {
    const client = harness.createClient("client-late", {
      recovery: TEST_RECOVERY,
      // What `collaborationRoom.join` answers for an ended or expired room. It
      // must not be retried: the budget would be spent and the reported reason
      // would be the wrong one.
      refreshJoinToken: () =>
        Promise.resolve({
          ok: false as const,
          retry: false as const,
          failure: "room-ended" as const,
        }),
    });
    client.session.connect();
    harness.settle();

    harness.network.dropConnection(client.transport);
    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);

    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "room-ended",
    });
    expect(client.tokenRefreshCount).toBe(1);
  });

  it("stops doing work after a terminal transport close", async () => {
    const client = harness.createClient("client-ended", {
      recovery: TEST_RECOVERY,
    });
    client.session.connect();
    harness.settle();
    client.edit((elements) => [...elements, rect("before-end")]);
    harness.settle();

    // A terminal close reported by the transport has to take the same teardown as
    // a terminal decision made here: otherwise the queue, the timers and the
    // subscription all keep running while the state machine says `failed`.
    harness.network.setDisconnectReason("room-ended");
    harness.network.dropConnection(client.transport);
    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "room-ended",
    });
    expect(client.timers.pendingCount).toBe(0);
    expect(client.scheduler.pendingCount).toBe(0);

    // The editor keeps calling — the caller has not torn the session down yet —
    // and none of it may schedule further work.
    client.edit((elements) => [...elements, rect("after-end")]);
    client.session.handlePointerUpdate({
      pointer: { x: 1, y: 1, tool: "pointer" },
      button: "up",
      pointersMap: new Map(),
    });
    expect(client.timers.pendingCount).toBe(0);
    expect(client.scheduler.pendingCount).toBe(0);
    expect(harness.network.pendingMessageCount()).toBe(0);
    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    expect(client.tokenRefreshCount).toBe(0);
  });

  it("drops a snapshot load still in flight when the session terminates", async () => {
    const backend = createSnapshotBackend();
    backend.publish([
      collabRectangle({ id: "room-owned" }) as unknown as SyncedElement,
    ]);
    const client = harness.createClient("client-cut-off", {
      recovery: TEST_RECOVERY,
      // Held open, so the terminal failure lands while the load is pending.
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    client.host.setElements([rect("local-only")]);
    client.session.connect();
    harness.settle();

    harness.network.setDisconnectReason("room-ended");
    harness.network.dropConnection(client.transport);
    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "room-ended",
    });

    // The load finally answers. It is guarded by the join epoch, not by the retry
    // epoch, so a terminal teardown that only invalidated the latter would let the
    // room's elements land on the canvas of a session that has already stopped.
    backend.resolveDeferredLoads();
    await harness.drainMicrotasks();

    expect(client.host.elements.map((element) => element.id)).toEqual([
      "local-only",
    ]);
  });

  it("stops for good when the room's generation was rotated", async () => {
    const client = harness.createClient("client-rotated", {
      recovery: TEST_RECOVERY,
      refreshJoinToken: () =>
        Promise.resolve({
          ok: true as const,
          token: "token-after-rotation",
          // The owner rotated the generation, so this session's derived key can
          // no longer open the room. Reconnecting would only look connected.
          authGeneration: 99,
        }),
    });
    client.session.connect();
    harness.settle();

    harness.network.dropConnection(client.transport);
    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);

    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "generation-rotated",
    });
    expect(client.timers.pendingCount).toBe(0);
  });

  it("gives up with `retry-limit` once the retry budget is spent", async () => {
    const client = harness.createClient("client-hopeless", {
      recovery: TEST_RECOVERY,
      refreshJoinToken: () =>
        Promise.resolve({ ok: false as const, retry: true as const }),
    });
    client.session.connect();
    harness.settle();

    harness.network.dropConnection(client.transport);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    }

    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "retry-limit",
    });
    // Exactly the configured budget, then it stops asking.
    expect(client.tokenRefreshCount).toBe(TEST_RECOVERY.maxAttempts);
    expect(client.timers.pendingCount).toBe(0);
  });

  it("gives up on a defect that reproduces right after every successful sync", async () => {
    // Plan 07 review follow-up: a relay defect that closes the connection on
    // the first post-baseline frame produces sessions that sync and die at
    // once. Each such session must keep spending one retry budget — a synced
    // baseline alone must not repay it — so the loop ends in `retry-limit`
    // instead of retrying forever from the first backoff delay.
    const client = harness.createClient("client-crashloop", {
      recovery: { ...TEST_RECOVERY, liveStabilityMs: 30_000 },
    });
    client.session.connect();
    harness.settle();

    for (let round = 0; round < 4; round += 1) {
      // The clock never advances between sync and drop: every live session
      // dies inside the stability window.
      harness.network.dropConnection(client.transport);
      if (client.session.getRecoveryState().phase === "failed") break;
      await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    }

    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "retry-limit",
    });
    expect(client.timers.pendingCount).toBe(0);

    // The same loop with stably live sessions never exhausts the budget: time
    // past the window between sync and drop repays it every round.
    const stable = harness.createClient("client-stable", {
      recovery: { ...TEST_RECOVERY, liveStabilityMs: 30_000 },
    });
    stable.session.connect();
    harness.settle();
    for (let round = 0; round < 6; round += 1) {
      harness.clock.now += 60_000;
      harness.network.dropConnection(stable.transport);
      await harness.advanceAndSettle([stable], PAST_EVERY_TIMER_MS);
    }
    expect(stable.session.getRecoveryState()).toEqual({ phase: "live" });
  });

  it("keeps retrying while the backend is merely unreachable", async () => {
    let attempts = 0;
    const client = harness.createClient("client-flaky", {
      recovery: TEST_RECOVERY,
      refreshJoinToken: () => {
        attempts += 1;
        // An unreachable backend is not a revoked membership, so it is retried.
        if (attempts === 1) return Promise.reject(new Error("network down"));
        return Promise.resolve({
          ok: true as const,
          token: "token-2",
          authGeneration: 1,
        });
      },
    });
    client.session.connect();
    harness.settle();

    harness.network.dropConnection(client.transport);
    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    expect(client.session.getRecoveryState()).toMatchObject({
      phase: "waiting",
      attempt: 2,
    });

    await harness.advanceAndSettle([client], PAST_EVERY_TIMER_MS);
    expect(client.session.getRecoveryState()).toEqual({ phase: "live" });
  });

  it("stops, and publishes nothing, when the room's snapshot cannot be read", async () => {
    const backend = createSnapshotBackend();
    backend.publish([]);
    // A viewer, so no peer answers the join with a snapshot: the unreadable
    // durable baseline is the only baseline this client can get, which is the
    // situation a link with the wrong key is actually in.
    const watcher = harness.createClient("client-watcher", {
      role: "viewer",
      recovery: TEST_RECOVERY,
    });
    watcher.session.connect();
    harness.settle();
    const seenByWatcher = observe(watcher);

    const wrongKey = harness.createClient("client-wrong-key", {
      recovery: TEST_RECOVERY,
      snapshotStore: backend.createStore({ outcome: "wrong-key" }),
    });
    // The canvas already holds unrelated local content, which is precisely what
    // must not be published into a room this client cannot read.
    wrongKey.host.setElements([rect("local-only")]);
    wrongKey.session.connect();
    // Captured while the socket is up: the terminal verdict below disconnects
    // the session, and a disconnected session has no peerId to ask for.
    const wrongKeyPeerId = peerIdOf(wrongKey);
    await harness.drainMicrotasks();
    harness.settle();

    expect(wrongKey.baselineOutcomes).toEqual(["unreadable-snapshot"]);
    expect(wrongKey.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "unreadable-room",
    });
    // Nothing was published, and nothing is left running.
    expect(sceneMessages(seenByWatcher, wrongKeyPeerId)).toEqual([]);
    expect(wrongKey.timers.pendingCount).toBe(0);
    expect(wrongKey.session.getConnectionState().status).toBe("disconnected");
  });

  it("stops when no realtime frame opens in a room that has no stored snapshot", async () => {
    // Plan 30. The snapshot oracle answers `empty` here — truthfully, the room has
    // never been persisted — so it establishes nothing about the key, and before
    // this the session would have sat connected, blank and silent forever.
    const backend = createSnapshotBackend();
    const watcher = harness.createClient("client-watcher-2", {
      recovery: TEST_RECOVERY,
    });
    watcher.session.connect();
    harness.settle();
    const seenByWatcher = observe(watcher);

    const probe = transportWithUnreadableProbe(
      harness.network.createTransport(),
    );
    const wrongKey = harness.createClient("client-blind", {
      recovery: TEST_RECOVERY,
      transport: probe.transport,
      snapshotStore: backend.createStore(),
    });
    wrongKey.session.connect();
    await harness.drainMicrotasks();
    harness.settle();

    // The join itself looks entirely healthy, which is the whole problem: an
    // empty room is a legitimate baseline, so the client publishes its canvas and
    // goes live with no indication that nothing it sends can be read.
    expect(wrongKey.baselineOutcomes).toEqual(["empty"]);
    expect(wrongKey.session.getRecoveryState()).toEqual({ phase: "live" });
    // Captured while live: the verdict below disconnects the session, and the
    // messages already seen carry this connection's peerId.
    const wrongKeyPeerId = peerIdOf(wrongKey);
    const publishedBeforeVerdict = sceneMessages(
      seenByWatcher,
      wrongKeyPeerId,
    ).length;

    probe.reportRoomUnreadable();

    expect(wrongKey.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "unreadable-room",
    });
    // Same teardown as the snapshot detector: the socket goes, and nothing is
    // left running to keep publishing into a room this client cannot read.
    expect(wrongKey.session.getConnectionState().status).toBe("disconnected");
    expect(wrongKey.timers.pendingCount).toBe(0);

    // A second verdict from a transport that has not been unsubscribed yet must
    // not re-report the same failure.
    const reportedFailures = wrongKey.recoveryStates.length;
    probe.reportRoomUnreadable();
    expect(wrongKey.recoveryStates).toHaveLength(reportedFailures);

    // And the editor keeps calling in after a terminal state, so the session has
    // to stop publishing rather than merely stop reconnecting.
    wrongKey.edit((elements) => [...elements, rect("drawn-after-verdict")]);
    harness.settle();
    expect(sceneMessages(seenByWatcher, wrongKeyPeerId)).toHaveLength(
      publishedBeforeVerdict,
    );
  });

  it("stops on the realtime verdict when the snapshot fetch keeps failing", async () => {
    // The other room the snapshot oracle cannot cover: a baseline that never
    // arrives. `snapshot-unavailable` is deliberately *not* terminal — it is
    // transient and the session must survive it — so without the realtime verdict
    // a wrong key here is as silent as in an unwritten room.
    const backend = createSnapshotBackend();
    backend.publish([]);
    const probe = transportWithUnreadableProbe(
      harness.network.createTransport(),
    );
    const client = harness.createClient("client-no-baseline", {
      recovery: TEST_RECOVERY,
      transport: probe.transport,
      snapshotStore: backend.createStore({ outcome: "unavailable" }),
    });
    client.session.connect();
    await harness.drainMicrotasks();
    harness.settle();

    expect(client.baselineOutcomes).toEqual(["snapshot-unavailable"]);
    expect(client.session.getRecoveryState()).toEqual({ phase: "live" });

    probe.reportRoomUnreadable();
    expect(client.session.getRecoveryState()).toEqual({
      phase: "failed",
      reason: "unreadable-room",
    });
  });

  it("does not retry a disconnect the caller asked for", () => {
    const client = harness.createClient("client-leaving", {
      recovery: TEST_RECOVERY,
    });
    client.session.connect();
    harness.settle();

    client.session.disconnect();
    expect(client.session.getRecoveryState()).toEqual({ phase: "idle" });
    expect(client.timers.pendingCount).toBe(0);
    expect(client.tokenRefreshCount).toBe(0);
  });

  it("opens no socket and leaves no timer when destroyed mid-reconnect", async () => {
    let released: (() => void) | undefined;
    const client = harness.createClient("client-torn-down", {
      recovery: TEST_RECOVERY,
      refreshJoinToken: () =>
        new Promise((resolve) => {
          released = () =>
            resolve({ ok: true, token: "late-token", authGeneration: 1 });
        }),
    });
    client.session.connect();
    harness.settle();

    harness.network.dropConnection(client.transport);
    client.timers.advance(PAST_EVERY_TIMER_MS);
    await harness.drainMicrotasks();
    // The refresh is in flight; tear the session down underneath it.
    client.session.destroy();
    released?.();
    await harness.drainMicrotasks();

    expect(client.session.getConnectionState().status).toBe("disconnected");
    expect(client.timers.pendingCount).toBe(0);
    expect(client.session.getRecoveryState()).toEqual({ phase: "idle" });
  });
});

describe("duplicate and out-of-order delivery", () => {
  it("ignores a duplicated scene frame instead of applying it twice", () => {
    const harness = createHarness({ random: createSeededRandom(3) });
    const alice = harness.createClient("client-a", { recovery: TEST_RECOVERY });
    const bob = harness.createClient("client-b", { recovery: TEST_RECOVERY });
    alice.session.connect();
    bob.session.connect();
    harness.settle();

    harness.network.setFaults({ duplicateProbability: 1 });
    alice.edit((elements) => [...elements, rect("dup")]);
    harness.settle();

    expect(
      bob.host.elements.filter((element) => element.id === "dup"),
    ).toHaveLength(1);
    expectAllConverged([alice, bob]);
  });

  it("rejects a stale frame that arrives behind a newer one and still converges", () => {
    // Scripted draws: hold alice's first delta twice, let the second through.
    const draws = [0, 0, 0.9];
    let draw = 0;
    const harness = createHarness({ random: () => draws[draw++] ?? 0.9 });
    const alice = harness.createClient("client-a", { recovery: TEST_RECOVERY });
    const bob = harness.createClient("client-b", { recovery: TEST_RECOVERY });
    alice.session.connect();
    bob.session.connect();
    harness.settle();

    harness.network.setFaults({ delayProbability: 0.5, maxDelayRounds: 2 });
    alice.edit((elements) => [...elements, rect("first")]);
    harness.network.flush();
    alice.edit((elements) => [...elements, rect("second")]);
    harness.network.flush();

    // `second` arrived first, so `first`'s sequence is now stale and the gate
    // refuses it — which is why convergence cannot rest on ordering.
    expect(bob.host.elements.map((element) => element.id)).toEqual(["second"]);

    harness.network.setFaults();
    healUntilConverged(harness, [alice, bob]);
    expectAllConverged([alice, bob]);
  });
});

/**
 * Drives the session's own repair path until every client agrees.
 *
 * The only lever pulled is *time*. No editor callback is injected, which is the
 * point: a dropped final delta has to heal without the user touching the canvas
 * again, so healing has to come from a timer the session armed itself. Each client
 * advances its own timers, the armed repair fires, the flush publishes a full
 * snapshot, and a received snapshot draws a reply from anyone holding state it
 * lacks. The loop terminates because equal states produce no reply and a published
 * snapshot arms nothing further.
 */
function healUntilConverged(
  harness: ReturnType<typeof createHarness>,
  clients: readonly TestClient[],
  maxRounds = 4,
): void {
  for (let round = 0; round < maxRounds; round += 1) {
    if (new Set(clients.map(sceneDigest)).size === 1) return;
    harness.clock.now += FULL_SCENE_SYNC_INTERVAL_MS;
    // One client at a time, settling in between. Firing the whole room at once
    // would put N snapshots in flight together, each drawing up to N-1 replies
    // that themselves draw replies — the exchange still terminates, but the
    // intermediate traffic grows fast enough to dominate the run.
    for (const client of clients) {
      client.timers.advance(FULL_SCENE_SYNC_INTERVAL_MS);
      client.scheduler.runAll();
      harness.settle(60);
    }
  }
}

describe("fault-matrix convergence", () => {
  /**
   * Fault profiles the matrix runs. `delayProbability` breaks session ordering,
   * which a real relay cannot do — it is in here because convergence must not
   * depend on ordering being true.
   */
  const PROFILES = [
    { name: "clean", faults: {} },
    { name: "drop", faults: { dropProbability: 0.35 } },
    { name: "duplicate", faults: { duplicateProbability: 0.35 } },
    { name: "reorder", faults: { delayProbability: 0.35, maxDelayRounds: 2 } },
    {
      name: "all",
      faults: {
        dropProbability: 0.25,
        duplicateProbability: 0.25,
        delayProbability: 0.25,
        maxDelayRounds: 2,
      },
    },
  ] as const;

  /**
   * Seeds every case runs on. Fixed rather than random so a run is reproducible,
   * and appended to — never replaced — when a seed is found that fails: a seed
   * that once broke convergence is the cheapest regression test there is.
   */
  const SEEDS = [1, 7, 20260805, 987654321];

  /**
   * Cases, and where coverage is deliberately traded for runtime.
   *
   * Convergence is established by exchanging snapshots, and every received
   * snapshot runs the real upstream reconciliation over the whole scene — so the
   * cost of one case grows with the *square* of the room size. Running the full
   * fault space at ten clients would take minutes for no extra information.
   *
   * So the split is explicit: fault breadth (and every seed) is covered at two
   * clients, where a case is cheap; five clients repeats the whole fault space on
   * one seed; and ten clients runs the combined profile, because what the largest
   * room adds is scale, not a new kind of fault. Nothing is sampled silently —
   * this list *is* the coverage.
   */
  const CASES: {
    clients: number;
    profile: string;
    seeds: number[];
    /** Concurrent edits before healing; kept low for the largest room. */
    edits: number;
  }[] = [
    ...PROFILES.map((profile) => ({
      clients: 2,
      profile: profile.name,
      seeds: SEEDS,
      edits: 8,
    })),
    ...PROFILES.map((profile) => ({
      clients: 5,
      profile: profile.name,
      seeds: [20260805],
      edits: 10,
    })),
    { clients: 10, profile: "all", seeds: [20260805], edits: 10 },
  ];

  for (const testCase of CASES) {
    const profile = PROFILES.find(({ name }) => name === testCase.profile);
    if (!profile) throw new Error(`unknown profile ${testCase.profile}`);
    for (const seed of testCase.seeds) {
      it(`converges with ${testCase.clients} clients under ${profile.name} faults (seed ${seed})`, async () => {
        const random = createSeededRandom(seed);
        const harness = createHarness({
          random,
          // A room exchanging snapshots puts a lot in flight at once; the bound
          // is about the fake network, not about the protocol.
          maxQueuedMessages: 4_096,
        });
        const clients = Array.from({ length: testCase.clients }, (_, index) =>
          harness.createClient(`client-${index}`, {
            recovery: TEST_RECOVERY,
          }),
        );
        for (const client of clients) {
          client.session.connect();
          harness.settle(60);
        }

        harness.network.setFaults(profile.faults);
        for (let round = 0; round < testCase.edits; round += 1) {
          const client = clients[Math.floor(random() * clients.length)];
          if (!client) continue;
          client.edit((elements) => [...elements, rect(`el-${round}`)]);
          harness.network.flush();
        }
        // A mid-run disconnect and rejoin, so every case covers the recovery
        // path and not only the delivery faults.
        const victim = clients[testCase.clients - 1];
        if (victim) {
          harness.network.dropConnection(victim.transport);
          victim.edit((elements) => [...elements, rect("offline-edit")]);
          await harness.advanceAndSettle([victim], PAST_EVERY_TIMER_MS);
        }

        harness.network.setFaults();
        healUntilConverged(harness, clients, 10);
        expectAllConverged(clients);
      }, 60_000); // down: the heal loop is bounded and cannot spin. // on purpose. A case that exceeds this has stopped converging, not slowed // Generous, because the cost is the real reconciliation these cases run
    }
  }
});
