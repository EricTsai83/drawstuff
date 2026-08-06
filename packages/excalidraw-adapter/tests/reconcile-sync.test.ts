// @vitest-environment jsdom

/**
 * Contract tests for the sync-side half of the reconciliation adapter: the
 * upstream tombstone/invisible-element sync policy and the changed-element
 * tracker that keeps broadcast payloads proportional to what changed.
 */

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";

import {
  createChangedElementTracker,
  DELETED_ELEMENT_SYNC_TIMEOUT_MS,
  getSyncableElements,
  isSyncableElement,
  markImageElementsUnavailable,
  reconcileRemoteElements,
  type ReconciliationLocalState,
} from "../src/reconcile";
import {
  createSyncRectangle,
  createSyncScene,
  editElement,
  RECONCILE_SCENE_FIXED_UPDATED,
} from "./support/reconcile-scenes";

const NOW = RECONCILE_SCENE_FIXED_UPDATED + 60_000;

const emptyLocalState: ReconciliationLocalState = {
  editingTextElement: null,
  newElement: null,
  resizingElement: null,
};

describe("getSyncableElements / isSyncableElement", () => {
  it("keeps live elements and fresh tombstones, drops aged-out tombstones", () => {
    const live = createSyncRectangle({ id: "live", index: "a0" });
    const freshTombstone = createSyncRectangle({
      id: "fresh-tombstone",
      index: "a1",
      isDeleted: true,
      updated: NOW - DELETED_ELEMENT_SYNC_TIMEOUT_MS + 60_000,
    });
    const agedTombstone = createSyncRectangle({
      id: "aged-tombstone",
      index: "a2",
      isDeleted: true,
      updated: NOW - DELETED_ELEMENT_SYNC_TIMEOUT_MS - 60_000,
    });

    expect(
      getSyncableElements([live, freshTombstone, agedTombstone], NOW).map(
        (element) => element.id,
      ),
    ).toEqual(["live", "fresh-tombstone"]);
  });

  it("drops invisibly small live elements but keeps invisible fresh tombstones", () => {
    // Mirrors upstream `isSyncableElement`: the tombstone branch only checks
    // `updated`, so a deleted 0x0 element still syncs (the deletion must
    // converge); only *live* invisible elements are dropped.
    const invisibleLive = createSyncRectangle({
      id: "invisible-live",
      index: "a0",
      width: 0,
      height: 0,
    });
    const invisibleTombstone = createSyncRectangle({
      id: "invisible-tombstone",
      index: "a1",
      width: 0,
      height: 0,
      isDeleted: true,
      updated: NOW,
    });
    const pointlessFreedraw = createSyncRectangle({
      id: "pointless-freedraw",
      index: "a2",
      type: "freedraw",
      points: [[0, 0]],
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
    });

    expect(isSyncableElement(invisibleLive, NOW)).toBe(false);
    expect(isSyncableElement(invisibleTombstone, NOW)).toBe(true);
    expect(isSyncableElement(pointlessFreedraw, NOW)).toBe(false);
  });
});

describe("createChangedElementTracker", () => {
  it("extracts the full syncable scene on syncAll and nothing right after", () => {
    const scene = createSyncScene(100);
    const tracker = createChangedElementTracker();

    const initial = tracker.extractChangedElements(scene, {
      now: NOW,
      syncAll: true,
    });
    expect(initial.elements).toHaveLength(100);

    initial.markSent();
    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([]);
  });

  it("extracts exactly the edited element, by reference, in scene order", () => {
    const scene = [...createSyncScene(100)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    scene[42] = editElement(scene[42]!);
    scene[7] = editElement(scene[7]!);

    const delta = tracker.extractChangedElements(scene, { now: NOW });
    expect(delta.elements).toHaveLength(2);
    // Scene order, not edit order — receivers depend on index-ordered
    // batches (upstream restore index-repairs out-of-order batches).
    expect(delta.elements[0]).toBe(scene[7]);
    expect(delta.elements[1]).toBe(scene[42]);

    // Committed state does not extract twice; an uncommitted (rejected-send)
    // batch would simply be extracted again.
    delta.markSent();
    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([]);
  });

  it("extracts a same-version element whose versionNonce moved", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    scene[3] = editElement(scene[3]!, {
      version: scene[3]!.version,
      versionNonce: scene[3]!.versionNonce + 1,
    });

    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([scene[3]]);
  });

  it("extracts a fresh deletion but never an aged-out tombstone", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    scene[3] = editElement(scene[3]!, { isDeleted: true, updated: NOW });
    const delta = tracker.extractChangedElements(scene, { now: NOW });
    expect(delta.elements.map((element) => element.id)).toEqual([scene[3].id]);

    scene[4] = editElement(scene[4]!, { isDeleted: true, updated: NOW });
    expect(
      tracker.extractChangedElements(scene, {
        now: NOW + DELETED_ELEMENT_SYNC_TIMEOUT_MS + 1,
      }).elements,
    ).toEqual([]);
  });

  it("marks only adopted remote elements as synced, and reset() forgets everything", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    // A remote peer edits element 2; we adopt it through reconciliation.
    const remoteEdit = [editElement(scene[2]!, { versionNonce: 5 })];
    const merged = reconcileRemoteElements(scene, remoteEdit, emptyLocalState);
    tracker.markAdoptedRemoteElements(merged, remoteEdit);

    // No echo: the adopted element is not extracted again.
    expect(
      tracker.extractChangedElements(merged, { now: NOW }).elements,
    ).toEqual([]);

    tracker.reset();
    expect(
      tracker.extractChangedElements(merged, { now: NOW }).elements,
    ).toHaveLength(10);
  });

  it("re-extracts a batch whose send was rejected, so a failed send retries instead of losing the edit", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    scene[3] = editElement(scene[3]!);

    // The transport rejects the send (not-connected / queue-overflow), so
    // the caller never commits — the same delta comes back on the next flush.
    const rejected = tracker.extractChangedElements(scene, { now: NOW });
    expect(rejected.elements).toEqual([scene[3]]);
    const retried = tracker.extractChangedElements(scene, { now: NOW });
    expect(retried.elements).toEqual([scene[3]]);

    // The retry succeeds and commits; only then does extraction go quiet.
    retried.markSent();
    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([]);
  });

  it("commits only the extracted snapshot when an element mutated in place after extraction", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    // Excalidraw mutates elements in place, so a re-entrant scene update can
    // bump the extracted object between serialization and commit. The commit
    // records the extraction-time snapshot — what the wire actually carried —
    // never the newer identity of the live object.
    const mutable = { ...scene[3]!, version: scene[3]!.version + 1 };
    scene[3] = mutable;

    const delta = tracker.extractChangedElements(scene, { now: NOW });
    expect(delta.elements).toEqual([mutable]);

    (mutable as { version: number }).version += 1;
    delta.markSent();

    // The newer in-place edit was never sent, so it must be extracted again.
    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([mutable]);
  });

  it("never lets a delayed stale commit suppress an edit extracted by a later flush", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    // Flush 1 extracts v(n+1) but its send stalls (commit is delayed).
    const mutable = { ...scene[3]!, version: scene[3]!.version + 1 };
    scene[3] = mutable;
    const staleBatch = tracker.extractChangedElements(scene, { now: NOW });
    expect(staleBatch.elements).toEqual([mutable]);

    // The shared object mutates in place to v(n+2); flush 2 extracts it and
    // commits first.
    (mutable as { version: number }).version += 1;
    const freshBatch = tracker.extractChangedElements(scene, { now: NOW });
    expect(freshBatch.elements).toEqual([mutable]);
    freshBatch.markSent();

    // The delayed commit of the older wire state must not clobber the newer
    // record — snapshots are batch-owned and older versions are skipped.
    staleBatch.markSent();
    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([]);

    // And if the newer flush had NOT committed, the stale commit may only
    // record what it sent, so the newer edit is still re-extracted.
    tracker.reset();
    const primed = tracker.extractChangedElements(scene, {
      now: NOW,
      syncAll: true,
    });
    primed.markSent();
    (mutable as { version: number }).version += 1;
    const stalled = tracker.extractChangedElements(scene, { now: NOW });
    (mutable as { version: number }).version += 1;
    tracker.extractChangedElements(scene, { now: NOW });
    stalled.markSent();
    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toEqual([mutable]);
  });

  it("never lets a delayed stale commit overwrite an adopted remote winner", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    // Local edit is extracted but its commit is delayed.
    scene[3] = editElement(scene[3]!);
    const staleBatch = tracker.extractChangedElements(scene, { now: NOW });
    expect(staleBatch.elements).toEqual([scene[3]]);

    // Meanwhile a newer remote edit for the same element wins and is adopted.
    const remoteEdit = [
      editElement(scene[3], {
        version: scene[3].version + 1,
        versionNonce: 777,
      }),
    ];
    const merged = reconcileRemoteElements(scene, remoteEdit, emptyLocalState);
    tracker.markAdoptedRemoteElements(merged, remoteEdit);

    // The stale local commit must not resurrect the older record and echo
    // the adopted scene back to peers.
    staleBatch.markSent();
    expect(
      tracker.extractChangedElements(merged, { now: NOW }).elements,
    ).toEqual([]);
  });

  it("voids commits from batches extracted before reset()", () => {
    const scene = [...createSyncScene(10)];
    const tracker = createChangedElementTracker();
    const staleSessionBatch = tracker.extractChangedElements(scene, {
      now: NOW,
      syncAll: true,
    });

    // A rejoin resets the tracker; the old session's in-flight batch must
    // not seed the new session's synced state.
    tracker.reset();
    staleSessionBatch.markSent();

    expect(
      tracker.extractChangedElements(scene, { now: NOW }).elements,
    ).toHaveLength(10);
  });

  it("syncAll re-extracts elements that are already recorded", () => {
    const scene = createSyncScene(10);
    const tracker = createChangedElementTracker();
    tracker
      .extractChangedElements(scene, { now: NOW, syncAll: true })
      .markSent();

    expect(
      tracker.extractChangedElements(scene, { now: NOW, syncAll: true })
        .elements,
    ).toHaveLength(10);
  });
});

describe("reconcileRemoteElements input safety", () => {
  it("never mutates the remote wire elements, even when indices need repair", () => {
    // An out-of-order remote batch triggers upstream's in-place index repair,
    // but only on the restored copies the adapter creates — the decoded wire
    // objects stay frozen-equivalent.
    const local = createSyncScene(3);
    const wireBatch = [
      createSyncRectangle({ id: "wire-b", index: "a1" }),
      createSyncRectangle({ id: "wire-a", index: "a0" }),
    ] as ExcalidrawElement[];
    const wireSnapshot = structuredClone(wireBatch);

    reconcileRemoteElements(local, wireBatch, emptyLocalState);

    expect(wireBatch).toEqual(wireSnapshot);
  });
});

describe("markImageElementsUnavailable", () => {
  const imageElement = (
    id: string,
    fileId: string | null,
    status: "pending" | "saved" | "error" = "saved",
  ): OrderedExcalidrawElement =>
    createSyncRectangle({
      id,
      index: "a1",
      type: "image",
      fileId,
      status,
      scale: [1, 1],
      crop: null,
      roundness: null,
    });

  it("marks only the images whose bytes are never coming", () => {
    const elements = [
      imageElement("img-gone", "file-gone"),
      imageElement("img-fine", "file-fine"),
      createSyncRectangle({ id: "rect", index: "a2" }),
    ];

    const marked = markImageElementsUnavailable(
      elements,
      new Set(["file-gone"]),
    );
    if (!marked) throw new Error("expected a marked scene");

    expect(
      marked.map((element) => (element as { status?: string }).status),
    ).toEqual(["error", "saved", undefined]);
    // The upstream version bump, so the mark converges like any other edit
    // rather than being silently dropped by reconciliation.
    expect(marked[0]?.version).toBe((elements[0]?.version ?? 0) + 1);
    // Untouched elements keep their identity, so nothing else is rebroadcast.
    expect(marked[1]).toBe(elements[1]);
    expect(marked[2]).toBe(elements[2]);
  });

  it("reports no change rather than rewriting the scene", () => {
    const elements = [
      imageElement("img-already", "file-a", "error"),
      imageElement("img-other", "file-b"),
      // An image element that never got a file id references nothing.
      imageElement("img-empty", null),
    ];

    // Nothing referenced, an id already marked, and an empty id set: all three
    // must leave the caller free to skip the scene write entirely.
    expect(
      markImageElementsUnavailable(elements, new Set(["file-c"])),
    ).toBeNull();
    expect(
      markImageElementsUnavailable(elements, new Set(["file-a"])),
    ).toBeNull();
    expect(markImageElementsUnavailable(elements, new Set())).toBeNull();
  });
});
