import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SCENE_MESSAGE_BYTES,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import {
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";
import type { OrderedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

import { drainAsync } from "./support/async-drain";
import {
  collabRectangle,
  editedElement,
} from "./support/collab-scene-fixtures";
import {
  AUTH_GENERATION,
  createHarness,
  ROOM_ID,
  ROOM_KEY,
  type TestClient,
} from "./support/collab-session-harness";
import { SNAPSHOT_INTERVAL_MS } from "@/lib/collab/collaboration-session";
import {
  createCollaborationSnapshotStore,
  type CollaborationSnapshotStore,
  type SaveSnapshotResult,
  type SnapshotApi,
} from "@/lib/collab/snapshot-store";

/**
 * Plan 19 step 7: a canvas that exceeds a locked size contract must not stop
 * syncing in silence.
 *
 * The contracts themselves are settled (Plan 12: 1 MiB per scene message; Plan
 * 15: 4 MiB per snapshot) and are not under test here — what is under test is
 * everything that happens *after* one of them is hit. Before this, an oversize
 * scene message failed with `oversize-payload`, no element was marked sent, and
 * the next `onChange` produced the identical failure with nobody informed, while
 * the room UI kept saying "共編中". The durable half was worse: `snapshot-store`
 * folded oversize into the same `{ status: "failed" }` as a network error, which
 * the session ignored outright.
 */

/**
 * An element whose body alone exceeds the scene-message budget.
 *
 * Element bodies pass the wire schema unprojected (`syncedElementSchema` is a
 * loose object), so this is a genuine oversize payload produced by the real
 * codec — the same rejection a real pasted mega-scene gets, not a stubbed error.
 */
function oversizeElement(
  id: string,
  byteLength = MAX_SCENE_MESSAGE_BYTES + 128,
): OrderedExcalidrawElement {
  return collabRectangle({ id, oversizePadding: "x".repeat(byteLength) });
}

describe("oversize scene payloads on the realtime path", () => {
  let harness: ReturnType<typeof createHarness>;
  let alice: TestClient;
  let bob: TestClient;

  beforeEach(() => {
    harness = createHarness();
    alice = harness.createClient("client-alice");
    bob = harness.createClient("client-bob");
    alice.session.connect();
    bob.session.connect();
    harness.settle();
  });

  it("reports the block instead of failing silently, and nothing reaches the room", () => {
    alice.edit((elements) => [...elements, oversizeElement("big")]);

    // The send was refused before anything was queued: the room never saw it.
    expect(harness.network.pendingMessageCount()).toBe(0);
    harness.settle();
    expect(bob.host.elements).toHaveLength(0);

    expect(alice.sceneSyncBlocks).toHaveLength(1);
    const block = alice.sceneSyncBlocks[0];
    expect(block?.realtime?.maxByteLength).toBe(MAX_SCENE_MESSAGE_BYTES);
    expect(block?.realtime?.byteLength).toBeGreaterThan(
      MAX_SCENE_MESSAGE_BYTES,
    );
    // The durable path has its own, larger budget and is not implicated.
    expect(block?.durable).toBeNull();
  });

  it("stays connected rather than terminating: the room still converges inbound", () => {
    alice.edit((elements) => [...elements, oversizeElement("big")]);
    harness.settle();

    // Not a terminal condition: an oversize canvas is recoverable, and a session
    // that stopped here would also stop receiving.
    expect(alice.session.getRecoveryState().phase).toBe("live");
    expect(alice.session.getConnectionState().status).toBe("connected");

    bob.edit((elements) => [...elements, collabRectangle({ id: "from-bob" })]);
    harness.settle();
    expect(alice.host.elements.map((element) => element.id)).toContain(
      "from-bob",
    );
  });

  it("announces the block once, not once per flush", () => {
    alice.edit((elements) => [...elements, oversizeElement("big")]);
    expect(alice.sceneSyncBlocks).toHaveLength(1);

    // Every subsequent edit re-extracts the same pending set and is refused
    // again. The condition has not changed, so the caller must not be told again.
    for (let edit = 0; edit < 3; edit += 1) {
      alice.edit((elements) =>
        elements.map((element) =>
          element.id === "big"
            ? editedElement(element, { x: edit + 1 })
            : element,
        ),
      );
    }
    expect(alice.sceneSyncBlocks).toHaveLength(1);
  });

  it("clears the block on the first accepted send once the canvas fits", () => {
    alice.edit((elements) => [
      ...elements,
      collabRectangle({ id: "r1" }),
      oversizeElement("big"),
    ]);
    expect(alice.sceneSyncBlocks).toHaveLength(1);
    expect(bob.host.elements).toHaveLength(0);

    // The canvas shrinks back under the budget (a reload of a compacted scene, or
    // an undo of the paste) and the pending set goes out as an ordinary delta.
    alice.edit((elements) =>
      elements
        .filter((element) => element.id !== "big")
        .map((element) => editedElement(element, { x: 12 })),
    );
    harness.settle();

    expect(alice.sceneSyncBlocks).toHaveLength(2);
    expect(alice.sceneSyncBlocks[1]).toBeNull();
    expect(bob.host.elements.map((element) => element.id)).toEqual(["r1"]);
  });
});

describe("oversize scenes on the durable path", () => {
  /**
   * A snapshot store whose write outcome the test controls. The real store's own
   * oversize classification is covered separately below; what this drives is the
   * session's reaction to it, which needs no encryption to be true.
   */
  function createControlledStore(): {
    store: CollaborationSnapshotStore;
    setResult(result: SaveSnapshotResult): void;
    readonly saveCount: number;
  } {
    let result: SaveSnapshotResult = {
      status: "oversize",
      byteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES + 4_096,
      maxByteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES,
    };
    let saveCount = 0;
    return {
      store: {
        load: () => Promise.resolve({ status: "empty" as const }),
        save: () => {
          saveCount += 1;
          return Promise.resolve(result);
        },
      },
      setResult(next) {
        result = next;
      },
      get saveCount() {
        return saveCount;
      },
    };
  }

  it("reports an oversize snapshot and clears it once a write lands", async () => {
    const harness = createHarness();
    const controlled = createControlledStore();
    const alice = harness.createClient("client-alice", {
      snapshotStore: controlled.store,
    });
    alice.session.connect();
    harness.settle();
    await drainAsync();

    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    expect(controlled.saveCount).toBe(1);
    expect(alice.sceneSyncBlocks).toHaveLength(1);
    expect(alice.sceneSyncBlocks[0]?.durable).toEqual({
      byteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES + 4_096,
      maxByteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES,
    });
    // Realtime is unaffected: the scene fits the smaller per-message budget.
    expect(alice.sceneSyncBlocks[0]?.realtime).toBeNull();

    // A repeated refusal on the next tick is the same condition, not a new one.
    alice.edit((elements) =>
      elements.map((element) => editedElement(element, { x: 3 })),
    );
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(controlled.saveCount).toBe(2);
    expect(alice.sceneSyncBlocks).toHaveLength(1);

    controlled.setResult({ status: "written", revision: 1 });
    alice.edit((elements) =>
      elements.map((element) => editedElement(element, { x: 4 })),
    );
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    expect(alice.sceneSyncBlocks).toHaveLength(2);
    expect(alice.sceneSyncBlocks[1]).toBeNull();
  });

  it("clears the block when the canvas is restored to the stored baseline", async () => {
    const harness = createHarness();
    const controlled = createControlledStore();
    controlled.setResult({ status: "written", revision: 1 });
    const alice = harness.createClient("client-alice", {
      snapshotStore: controlled.store,
    });
    alice.session.connect();
    harness.settle();
    await drainAsync();

    // A baseline lands, so the session now knows what the store holds.
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    const baseline = alice.host.elements;
    expect(alice.sceneSyncBlocks).toHaveLength(0);

    // An oversize edit blocks the durable path.
    controlled.setResult({
      status: "oversize",
      byteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES + 4_096,
      maxByteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES,
    });
    alice.edit((elements) => [...elements, collabRectangle({ id: "huge" })]);
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(alice.sceneSyncBlocks).toHaveLength(1);
    expect(alice.sceneSyncBlocks[0]?.durable).not.toBeNull();

    // Undone back to exactly what the store already holds. No write is needed —
    // which is precisely why the block has to clear here rather than wait for one.
    alice.host.setElements(baseline);
    const savesBefore = controlled.saveCount;
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    expect(controlled.saveCount).toBe(savesBefore);
    expect(alice.sceneSyncBlocks).toHaveLength(2);
    expect(alice.sceneSyncBlocks[1]).toBeNull();
  });

  it("keeps ignoring a plain write failure: it is retried, not reported", async () => {
    const harness = createHarness();
    const controlled = createControlledStore();
    controlled.setResult({ status: "failed" });
    const alice = harness.createClient("client-alice", {
      snapshotStore: controlled.store,
    });
    alice.session.connect();
    harness.settle();
    await drainAsync();

    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();

    expect(controlled.saveCount).toBe(1);
    expect(alice.sceneSyncBlocks).toHaveLength(0);
  });
});

describe("snapshot store size classification", () => {
  const snapshotApi = (
    put: SnapshotApi["put"] = () =>
      Promise.resolve({ status: "written" as const, revision: 1 }),
  ): SnapshotApi => ({
    get: () =>
      Promise.resolve({ authGeneration: AUTH_GENERATION, snapshot: null }),
    put,
  });

  const buildStore = (
    put?: SnapshotApi["put"],
  ): Promise<CollaborationSnapshotStore> =>
    createCollaborationSnapshotStore({
      api: snapshotApi(put),
      roomId: ROOM_ID,
      roomKey: ROOM_KEY,
      authGeneration: AUTH_GENERATION,
    });

  it("distinguishes an oversize scene from a failed write", async () => {
    const store = await buildStore();
    const oversize = await store.save({
      elements: [
        oversizeElement("big", MAX_SNAPSHOT_PLAINTEXT_BYTES + 128),
      ] as unknown as readonly SyncedElement[],
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    expect(oversize.status).toBe("oversize");
    if (oversize.status !== "oversize") throw new Error("expected oversize");
    expect(oversize.maxByteLength).toBe(MAX_SNAPSHOT_PLAINTEXT_BYTES);
    expect(oversize.byteLength).toBeGreaterThan(MAX_SNAPSHOT_PLAINTEXT_BYTES);
  });

  it("still reports a transport failure as failed", async () => {
    const store = await buildStore(() => Promise.reject(new Error("offline")));
    const result = await store.save({
      elements: [
        collabRectangle({ id: "r1" }),
      ] as unknown as readonly SyncedElement[],
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    expect(result).toEqual({ status: "failed" });
  });
});
