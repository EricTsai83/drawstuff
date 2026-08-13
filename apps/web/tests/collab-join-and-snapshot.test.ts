import { beforeEach, describe, expect, it } from "vitest";

import {
  collaborationSnapshotDigest,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";
import type { SyncedElement } from "@drawstuff/collaboration/protocol";
import type { OrderedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

import { SNAPSHOT_INTERVAL_MS } from "@/lib/collab/collaboration-session";
import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";
import {
  collabRectangle,
  editedElement,
  sortSceneById,
} from "./support/collab-scene-fixtures";
import {
  createHarness,
  createRawSender,
  createSnapshotBackend,
  expectConverged,
  ROOM_ID,
} from "./support/collab-session-harness";

/**
 * Plan 15: joining a room without losing an update, and recovering a room from
 * its durable snapshot.
 *
 * Every scenario is driven by observable state — membership notices, delivered
 * messages, injected timers — never by a sleep. The join deadline and the
 * snapshot cadence are injected, so "the peer never answered" and "the cadence
 * fired" are things a test states rather than waits for. The only asynchrony left
 * is the snapshot load itself, which is drained explicitly.
 */

type Harness = ReturnType<typeof createHarness>;

/**
 * Lets queued async work (snapshot loads, Web Crypto digests) run without
 * delivering any message. Both microtasks and one macrotask per round, because
 * `crypto.subtle.digest` does not settle on the microtask queue alone.
 */
const drainAsync = async (): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/**
 * Runs the room until nothing is in flight: snapshot loads resolve, messages are
 * delivered, and the snapshot replies they draw are delivered too. Terminates
 * because `sceneInitNeedsReply` produces no reply between equal states.
 */
const settle = async (harness: Harness): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    await drainAsync();
    if (harness.network.pendingMessageCount() === 0) return;
    harness.network.flush();
  }
  throw new Error("collaboration exchange did not settle");
};

const digest = (
  elements: readonly OrderedExcalidrawElement[],
): Promise<string> =>
  collaborationSnapshotDigest(elements as unknown as readonly SyncedElement[]);

const asSyncedElements = (
  elements: readonly OrderedExcalidrawElement[],
): readonly SyncedElement[] => elements as unknown as readonly SyncedElement[];

describe("join barrier", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("reports an empty room as soon as membership and the baseline are known", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });

    alice.session.connect();
    await settle(harness);

    // No deadline was needed: an empty room settles on what it knows.
    expect(alice.baselineOutcomes).toEqual(["empty"]);
    expect(alice.host.elements).toEqual([]);
    expect(alice.timers.pendingCount).toBe(1); // the snapshot cadence only
  });

  it("takes the elected peer's snapshot when it wins the race", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [
      ...elements,
      collabRectangle({ id: "r1" }),
      collabRectangle({ id: "r2", isDeleted: true }),
    ]);
    await settle(harness);

    // Bob's store fetch is held open, so the elected peer's reply is the first
    // baseline to arrive.
    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    bob.session.connect();
    harness.network.flush();
    await drainAsync();

    expect(bob.baselineOutcomes).toEqual(["peer"]);
    expect(sortSceneById(bob.host.elements).map((el) => el.id)).toEqual([
      "r1",
      "r2",
    ]);
    expect(await digest(bob.host.elements)).toBe(
      await digest(alice.host.elements),
    );
  });

  it("loses no update published while the joiner is still waiting for a baseline", async () => {
    const backend = createSnapshotBackend();
    // A raw peer publishes without any session logic, so it never answers a
    // newcomer — which is exactly the window this test needs to stay open.
    const raw = createRawSender(harness.network);
    backend.publish(asSyncedElements([collabRectangle({ id: "stored" })]));

    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    bob.session.connect();
    await drainAsync();
    expect(bob.baselineOutcomes).toEqual([]);

    // The race the barrier exists for: an edit published after Bob subscribed
    // but before any baseline arrived. A fetch-then-subscribe joiner would have
    // it in neither the baseline nor any later message.
    raw.transport.sendSceneMessage(
      raw.sceneMessage({
        sequence: 1,
        elements: [collabRectangle({ id: "live" })],
      }),
    );
    harness.network.flush();
    await drainAsync();
    // Still holding, and the update is buffered rather than dropped.
    expect(bob.baselineOutcomes).toEqual([]);
    expect(bob.host.elements).toEqual([]);

    backend.resolveDeferredLoads();
    await settle(harness);

    expect(bob.baselineOutcomes).toEqual(["durable-snapshot"]);
    expect(sortSceneById(bob.host.elements).map((el) => el.id)).toEqual([
      "live",
      "stored",
    ]);
  });

  it("does not publish the joiner's pre-join canvas before the baseline lands", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);

    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    // Content on Bob's canvas that is not the room's. Nothing may leave until
    // the baseline resolves — this is the leak Plan 13 refused joins to avoid.
    bob.host.setElements([collabRectangle({ id: "stray" })]);
    bob.session.connect();
    await drainAsync();
    bob.edit((elements) => elements);
    harness.network.flush();

    expect(alice.host.elements.some((el) => el.id === "stray")).toBe(false);
  });

  it("falls back to the durable snapshot after a relay restart", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [
      ...elements,
      collabRectangle({ id: "r1" }),
      collabRectangle({ id: "r2", isDeleted: true }),
    ]);
    await settle(harness);
    // Alice is the elected writer, so the cadence publishes the baseline.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.revision).toBeGreaterThan(SNAPSHOT_NO_REVISION);

    // Relay restart: every member is dropped and in-flight traffic is lost, so
    // no live copy of the scene is left anywhere.
    const aliceDigest = await digest(alice.host.elements);
    harness.network.restartRoom(ROOM_ID);

    const carol = harness.createClient("client-carol", {
      snapshotStore: backend.createStore(),
    });
    carol.session.connect();
    await settle(harness);

    expect(carol.baselineOutcomes).toEqual(["durable-snapshot"]);
    expect(await digest(carol.host.elements)).toBe(aliceDigest);
  });

  it("converges on the loser's snapshot too, whichever baseline won", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "old" })]));

    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    expect(alice.baselineOutcomes).toEqual(["durable-snapshot"]);
    alice.edit((elements) => [...elements, collabRectangle({ id: "fresh" })]);
    await settle(harness);

    // Bob's store answers first, so the stored baseline wins the race. The
    // elected peer's snapshot still arrives as ordinary traffic, which is why
    // racing is safe: the loser is not lost, only later.
    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore(),
    });
    bob.session.connect();
    await settle(harness);

    expect(bob.baselineOutcomes).toEqual(["durable-snapshot"]);
    expect(sortSceneById(bob.host.elements).map((el) => el.id)).toEqual([
      "fresh",
      "old",
    ]);
    expect(await digest(bob.host.elements)).toBe(
      await digest(alice.host.elements),
    );
  });

  it("resolves both sides of simultaneous joins into an empty room", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore(),
    });

    // Neither can answer the other: both are newcomers in the same membership
    // change, so neither waits for a snapshot that will never come.
    alice.session.connect();
    bob.session.connect();
    await settle(harness);

    expect(alice.baselineOutcomes).toHaveLength(1);
    expect(bob.baselineOutcomes).toHaveLength(1);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);
    expectConverged(alice, bob);
  });

  it("releases on the deadline when the store never answers", async () => {
    const backend = createSnapshotBackend();
    const bob = harness.createClient("client-bob", {
      // Never resolved: the store hangs for the whole test.
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    bob.session.connect();
    await drainAsync();
    expect(bob.baselineOutcomes).toEqual([]);

    // The deadline is the escape hatch: the barrier must never hold the canvas
    // (or inbound traffic) indefinitely.
    bob.timers.advance(60_000);
    await drainAsync();
    expect(bob.baselineOutcomes).toEqual(["snapshot-unavailable"]);
  });

  it("repairs a barrier buffer overflow with its own snapshot broadcast", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore({ deferLoad: true }),
      // One held message, so the second overflows and the buffer is dropped.
      joinBarrier: { maxBufferedMessages: 1 },
    });
    bob.session.connect();
    await drainAsync(); // holding: no baseline has arrived yet

    // Two updates while holding: the first is buffered, the second overflows and
    // takes the buffer with it. Alice's own snapshot reply is delivered in the
    // same batch and would otherwise end the hold, so it is drained last.
    alice.edit((elements) => [...elements, collabRectangle({ id: "r2" })]);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r3" })]);
    harness.network.flush();
    await drainAsync();
    backend.resolveDeferredLoads();
    await settle(harness);

    // Convergence is restored even though held traffic was thrown away: Bob's
    // post-baseline snapshot draws Alice's reply, which carries the losses.
    expect(sortSceneById(bob.host.elements).map((el) => el.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(await digest(bob.host.elements)).toBe(
      await digest(alice.host.elements),
    );
  });

  it("reports an unreadable snapshot instead of pretending the room is empty", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "r1" })]));
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore({ outcome: "wrong-key" }),
    });

    alice.session.connect();
    await settle(harness);

    expect(alice.baselineOutcomes).toEqual(["unreadable-snapshot"]);
    expect(alice.host.elements).toEqual([]);
  });

  it("stops holding and clears timers when destroyed mid-join", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);

    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    bob.session.connect();
    await drainAsync(); // holding

    bob.session.destroy();
    expect(bob.timers.pendingCount).toBe(0);
    // Nothing is claimed after teardown, and no buffered message is applied.
    await settle(harness);
    expect(bob.baselineOutcomes).toEqual([]);
  });
});

describe("durable snapshot cadence", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("writes only from the elected writer, and only when the scene moved", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    bob.session.connect();
    await settle(harness);

    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    // Both cadences fire; exactly one member is the writer.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    bob.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.revision).toBe(1);
    expect(backend.saves).toHaveLength(1);

    // An idle room writes nothing: the semantic digest has not changed.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    bob.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.saves).toHaveLength(1);
    expect(backend.revision).toBe(1);
  });

  it("hands the writer role over when the elected writer leaves", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    bob.session.connect();
    await settle(harness);

    alice.session.disconnect();
    await settle(harness);

    bob.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);
    bob.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    // A departed (or crashed) writer must not stop the room from persisting.
    expect(backend.revision).toBe(1);
    expect(backend.elements.map((el) => el.id)).toEqual(["r1"]);
  });

  it("merges the winner's elements before writing again after a conflict", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "mine" })]);
    await settle(harness);

    // Another writer publishes an element Alice has never seen.
    backend.publish(asSyncedElements([collabRectangle({ id: "theirs" })]));

    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    // The conflict is not "adopt the revision and carry on": adopting only the
    // number would let the next write publish Alice's canvas at N+1 and erase
    // `theirs`. The winner's elements are re-read and merged instead.
    expect(sortSceneById(alice.host.elements).map((el) => el.id)).toEqual([
      "mine",
      "theirs",
    ]);

    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "mine",
      "theirs",
    ]);
  });

  it("applies a durable load that resolved after the join deadline", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "stored" })]));
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore({ deferLoad: true }),
    });
    alice.session.connect();
    await drainAsync();

    // The deadline releases the barrier with no baseline.
    alice.timers.advance(60_000);
    await drainAsync();
    expect(alice.baselineOutcomes).toEqual(["snapshot-unavailable"]);

    // The load then arrives late. Recording its revision while discarding its
    // elements is exactly how the next cadence tick would overwrite it.
    backend.resolveDeferredLoads();
    await drainAsync();
    expect(alice.host.elements.map((el) => el.id)).toEqual(["stored"]);

    alice.edit((elements) => [...elements, collabRectangle({ id: "mine" })]);
    await settle(harness);
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "mine",
      "stored",
    ]);
  });

  it("adopts the winner's revision when a stale write conflicts", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    // Another writer publishes first, so Alice's expected revision is stale.
    backend.publish(asSyncedElements([collabRectangle({ id: "other" })]));
    expect(backend.revision).toBe(1);

    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    // Refused, and the stored baseline was not clobbered.
    expect(backend.saves).toEqual([{ expectedRevision: 0, count: 1 }]);
    expect(backend.elements.map((el) => el.id)).toEqual(["other"]);

    // The conflict taught Alice the real revision *and* made her re-read the
    // winner, so the next tick lands and carries both elements. No retry storm in
    // between: one attempt per tick.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.revision).toBe(2);
    expect(backend.saves.at(-1)).toEqual({ expectedRevision: 1, count: 2 });
  });

  it("never replaces a baseline it could not read", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "r1" })]));
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore({ outcome: "wrong-key" }),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "mine" })]);
    await settle(harness);

    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    // Writing here would destroy room history on the strength of a canvas this
    // client has no reason to believe is complete.
    expect(backend.saves).toEqual([]);
    expect(backend.elements.map((el) => el.id)).toEqual(["r1"]);
  });

  it("recovers from a transient fetch failure instead of never writing again", async () => {
    const backend = createSnapshotBackend();
    const store = backend.createStore();
    let failing = true;
    const flaky: CollaborationSnapshotStore = {
      load: () =>
        failing
          ? Promise.resolve({
              status: "unreadable" as const,
              reason: "unavailable" as const,
            })
          : store.load(),
      save: (input) => store.save(input),
    };
    const alice = harness.createClient("client-alice", {
      snapshotStore: flaky,
    });
    alice.session.connect();
    await settle(harness);
    expect(alice.baselineOutcomes).toEqual(["snapshot-unavailable"]);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    // Not knowing the baseline correctly blocks the write...
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.saves).toEqual([]);

    // ...but the cadence retries the read, so one failed fetch does not disable
    // snapshots for the rest of the session.
    failing = false;
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.revision).toBe(1);
    expect(backend.elements.map((el) => el.id)).toEqual(["r1"]);
  });

  it("never writes from a viewer", async () => {
    const backend = createSnapshotBackend();
    const viewer = harness.createClient("client-viewer", {
      role: "viewer",
      snapshotStore: backend.createStore(),
    });
    viewer.session.connect();
    await settle(harness);

    viewer.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.saves).toEqual([]);
  });

  it("does not write a canvas that no longer belongs to the room", async () => {
    const backend = createSnapshotBackend();
    let attached = true;
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
      canSyncScene: () => attached,
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    attached = false; // another scene was loaded onto the canvas
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.saves).toEqual([]);
  });

  it("flushes on teardown so an emptying room keeps a current baseline", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [
      ...elements,
      editedElement(collabRectangle({ id: "r1" }), { x: 77 }),
    ]);
    await settle(harness);

    // The last participant leaving is the moment no live copy of the scene is
    // left, so the flush must not wait for the next cadence tick.
    await alice.session.flushSnapshot();
    expect(backend.revision).toBe(1);
    expect(backend.elements.map((el) => el.id)).toEqual(["r1"]);
    expect(backend.saveIntents).toEqual(["leave"]);
  });

  it("completes the leave flush even though teardown happens in the same tick", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    // This is what `room-session.ts` actually does on teardown, and the digest in
    // between is asynchronous: a plain teardown guard aborts the flush every
    // single time, which no test that awaited `flushSnapshot()` alone would show.
    const flushed = alice.session.flushSnapshot();
    alice.session.destroy();
    await flushed;
    await drainAsync();

    expect(backend.revision).toBe(1);
    expect(backend.elements.map((el) => el.id)).toEqual(["r1"]);
  });

  it("queues the leave flush behind an in-flight cadence write", async () => {
    const backend = createSnapshotBackend();
    let releaseSave: (() => void) | undefined;
    const store = backend.createStore();
    const gatedStore = {
      load: store.load,
      save: async (input: Parameters<typeof store.save>[0]) => {
        if (!releaseSave) {
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        return store.save(input);
      },
    };
    const alice = harness.createClient("client-alice", {
      snapshotStore: gatedStore,
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "first" })]);
    await settle(harness);

    // A cadence write starts and stalls mid-save.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    // The user then makes one more edit and leaves. Skipping the flush because a
    // write is "in flight" would persist only the pre-edit scene, and teardown
    // cancels every future tick that could have caught up.
    alice.edit((elements) => [...elements, collabRectangle({ id: "last" })]);
    await settle(harness);
    const flushed = alice.session.flushSnapshot();
    releaseSave?.();
    alice.session.destroy();
    await flushed;
    await drainAsync();

    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "first",
      "last",
    ]);
    expect(backend.saveIntents).toEqual(["cadence", "leave"]);
  });

  it("persists the last edit when the transport closes while a cadence write is in flight", async () => {
    const backend = createSnapshotBackend();
    let releaseSave: (() => void) | undefined;
    const store = backend.createStore();
    const gatedStore = {
      load: store.load,
      save: async (input: Parameters<typeof store.save>[0]) => {
        if (!releaseSave) {
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        return store.save(input);
      },
    };
    const alice = harness.createClient("client-alice", {
      snapshotStore: gatedStore,
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "first" })]);
    await settle(harness);

    // A cadence write starts and stalls mid-save.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    // One more edit lands inside the stalled window, and the tab closes. This
    // is `room-session.destroy()` exactly: the flush is requested first, but
    // the transport closes in the same tick, so the session hears the drop —
    // and loses `connected` — long before the stalled write settles. The flush
    // decision must therefore be made before waiting, or the room's durable
    // baseline stops at "first" forever.
    alice.edit((elements) => [...elements, collabRectangle({ id: "last" })]);
    const flushed = alice.session.flushSnapshot();
    alice.transport.close();
    alice.session.destroy();
    releaseSave?.();
    await flushed;
    await drainAsync();

    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "first",
      "last",
    ]);
    expect(backend.saveIntents).toEqual(["cadence", "leave"]);
  });

  it("merges the winner when the awaited cadence write lost a conflict during teardown", async () => {
    const backend = createSnapshotBackend();
    let releaseSave: (() => void) | undefined;
    const store = backend.createStore();
    const gatedStore = {
      load: store.load,
      save: async (input: Parameters<typeof store.save>[0]) => {
        if (!releaseSave) {
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        return store.save(input);
      },
    };
    const alice = harness.createClient("client-alice", {
      snapshotStore: gatedStore,
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "mine" })]);
    await settle(harness);

    // The cadence write stalls mid-save…
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    // …and another leaver wins the revision race while it hangs.
    backend.publish(asSyncedElements([collabRectangle({ id: "theirs" })]));

    // Teardown queues the leave flush behind the stalled write. That write
    // loses its conflict and — because the session is destroyed — adopts the
    // winner's revision without reading the winner's elements. The queued
    // flush must not write the captured scene under that adopted revision:
    // it would pass the conditional write and erase "theirs" for good.
    const flushed = alice.session.flushSnapshot();
    alice.transport.close();
    alice.session.destroy();
    releaseSave?.();
    await flushed;
    await drainAsync();

    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "mine",
      "theirs",
    ]);
  });

  it("merges the winner even when the conflict re-read finishes before teardown", async () => {
    const backend = createSnapshotBackend();
    let releaseSave: (() => void) | undefined;
    const store = backend.createStore();
    const gatedStore = {
      load: store.load,
      save: async (input: Parameters<typeof store.save>[0]) => {
        if (!releaseSave) {
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        return store.save(input);
      },
    };
    const alice = harness.createClient("client-alice", {
      snapshotStore: gatedStore,
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "mine" })]);
    await settle(harness);

    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    backend.publish(asSyncedElements([collabRectangle({ id: "theirs" })]));

    // The flush is awaited *without* tearing the session down (the handle
    // returns the promise for exactly such callers), so the conflicted cadence
    // write completes its baseline re-read: the baseline is known again and
    // the winner's revision adopted. The captured scene still predates the
    // winner, so the flush must conflict and merge rather than trust the
    // repaired baseline and overwrite "theirs".
    const flushed = alice.session.flushSnapshot();
    releaseSave?.();
    await flushed;
    await drainAsync();

    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "mine",
      "theirs",
    ]);
  });

  it("merges and retries a forced flush that loses the revision race", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "mine" })]);
    await settle(harness);

    // Another leaver wins the race from the same revision with an element Alice
    // never received.
    backend.publish(asSyncedElements([collabRectangle({ id: "theirs" })]));

    const flushed = alice.session.flushSnapshot();
    alice.session.destroy();
    await flushed;
    await drainAsync();

    // There is no next cadence tick after teardown, so the forced path has to
    // merge the winner and retry itself — otherwise Alice's edit is lost the
    // moment the room empties.
    expect(backend.elements.map((el) => el.id).sort()).toEqual([
      "mine",
      "theirs",
    ]);
    expect(backend.saveIntents).toEqual(["leave", "leave"]);
    expect(backend.revision).toBe(2);
  });

  it("flushes on leave even while a crashed peer still looks like the writer", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    const bob = harness.createClient("client-bob", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    bob.session.connect();
    await settle(harness);

    // Alice is the elected writer (smallest peer id). Bob leaves while still
    // believing she is — the case where her crash notice has not arrived yet.
    expect(backend.saves).toEqual([]);
    bob.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    const flushed = bob.session.flushSnapshot();
    bob.session.destroy();
    await flushed;
    await drainAsync();

    // The forced flush bypasses election, so the last live copy is persisted.
    expect(backend.revision).toBe(1);
    expect(backend.elements.map((el) => el.id)).toEqual(["r1"]);
  });

  it("still refuses a leave flush from a viewer or an unknown baseline", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "stored" })]));

    const viewer = harness.createClient("client-viewer", {
      role: "viewer",
      snapshotStore: backend.createStore(),
    });
    viewer.session.connect();
    await settle(harness);
    await viewer.session.flushSnapshot();

    const blind = harness.createClient("client-blind", {
      snapshotStore: backend.createStore({ outcome: "wrong-key" }),
    });
    blind.session.connect();
    await settle(harness);
    await blind.session.flushSnapshot();

    // Bypassing the election must not also bypass the role and baseline checks.
    expect(backend.saves).toEqual([]);
    expect(backend.elements.map((el) => el.id)).toEqual(["stored"]);
  });

  it("repairs a viewer's overflowed join by re-reading the durable baseline", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "stored" })]));
    const raw = createRawSender(harness.network);

    const viewer = harness.createClient("client-viewer", {
      role: "viewer",
      snapshotStore: backend.createStore({ deferLoad: true }),
      joinBarrier: { maxBufferedMessages: 1 },
    });
    viewer.session.connect();
    await drainAsync();

    // Two updates while holding: the second overflows and drops the buffer.
    for (const id of ["a", "b"]) {
      raw.transport.sendSceneMessage(
        raw.sceneMessage({
          sequence: id === "a" ? 1 : 2,
          elements: [collabRectangle({ id })],
        }),
      );
    }
    harness.network.flush();
    await drainAsync();

    const loadsBeforeRelease = backend.loadCount;
    backend.resolveDeferredLoads();
    await settle(harness);

    // A viewer cannot publish, so the usual repair — broadcasting its own
    // snapshot — is unavailable to it. Re-reading the stored baseline is the
    // repair it does have.
    expect(backend.loadCount).toBeGreaterThan(loadsBeforeRelease);
    expect(viewer.host.elements.map((el) => el.id)).toEqual(["stored"]);
  });

  it("stops the cadence once the session is destroyed", async () => {
    const backend = createSnapshotBackend();
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.createStore(),
    });
    alice.session.connect();
    await settle(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settle(harness);

    alice.session.destroy();
    expect(alice.timers.pendingCount).toBe(0);
    alice.timers.advance(SNAPSHOT_INTERVAL_MS * 3);
    await drainAsync();
    expect(backend.saves).toEqual([]);
  });

  it("cleans up after a terminal failure without the transport's disconnect notice", async () => {
    const backend = createSnapshotBackend();
    backend.publish(asSyncedElements([collabRectangle({ id: "stored" })]));

    // A transport that reports the drop asynchronously — which a terminated
    // session never hears, because it unsubscribes as part of terminating. The
    // session must clear its own state and timers rather than wait for a
    // notification that relay-client happens to deliver synchronously today.
    const inner = harness.network.createTransport();
    const transport: typeof inner = {
      ...inner,
      subscribe: (subscriber) => {
        let active = true;
        const unsubscribe = inner.subscribe({
          ...subscriber,
          onConnectionStateChange: (state) => {
            if (state.status !== "disconnected") {
              subscriber.onConnectionStateChange?.(state);
              return;
            }
            queueMicrotask(() => {
              if (active) subscriber.onConnectionStateChange?.(state);
            });
          },
        });
        return () => {
          active = false;
          unsubscribe();
        };
      },
    };

    const alice = harness.createClient("client-alice", {
      transport,
      snapshotStore: backend.createStore({ outcome: "wrong-key" }),
    });
    alice.session.connect();
    await settle(harness);

    expect(alice.recoveryStates.at(-1)).toMatchObject({
      phase: "failed",
      reason: "unreadable-room",
    });
    // No cadence tick, join deadline or repair timer survives termination…
    expect(alice.timers.pendingCount).toBe(0);
    // …and the leave flush of a terminated session writes nothing.
    await alice.session.flushSnapshot();
    expect(backend.saves).toEqual([]);
    expect(backend.elements.map((el) => el.id)).toEqual(["stored"]);
  });
});
