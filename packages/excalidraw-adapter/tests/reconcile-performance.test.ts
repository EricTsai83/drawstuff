// @vitest-environment jsdom

/**
 * Plan 10 reconciliation measurements over the fixed 1k/10k scenes
 * (`plan-10-reconcile-scene`): local change extraction, remote reconcile,
 * allocation and payload bytes.
 *
 * Structural guarantees (payload proportionality, no-clone extraction, exact
 * change counts) are always asserted. Timing and allocation budgets are hard
 * gates only under `ENFORCE_EXCALIDRAW_PERFORMANCE_BUDGETS=1`, calibrated on
 * the machine class in `docs/performance/reconciliation-adapter.md`; the
 * measured JSON is always printed for comparison against that document.
 */

import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";

import {
  createChangedElementTracker,
  reconcileRemoteElements,
  type ReconciliationLocalState,
} from "../src/reconcile";
import {
  createSyncScene,
  editElement,
  RECONCILE_SCENE_FIXED_UPDATED,
} from "./support/reconcile-scenes";

const NOW = RECONCILE_SCENE_FIXED_UPDATED + 60_000;
const ITERATIONS = 30;
const WARMUP_ITERATIONS = 5;
const SCENE_SIZES = [1_000, 10_000] as const;
const REMOTE_DELTA_SIZE = 10;

const enforceBudgets =
  process.env.ENFORCE_EXCALIDRAW_PERFORMANCE_BUDGETS === "1";

/**
 * Calibrated on the `MacBookPro18,1` baseline machine
 * (docs/performance/reconciliation-adapter.md) with ample headroom over the
 * captured p95 values.
 */
const RECONCILE_PERFORMANCE_BUDGETS = {
  extractSingleEdit10kP95Ms: 2,
  extractNoop10kP95Ms: 2,
  reconcileDelta10Into10kP95Ms: 10,
  reconcileSceneInit10kP95Ms: 40,
  extractionWorkingHeapDeltaBytes: 2 * 1024 * 1024,
  reconcile10kWorkingHeapDeltaBytes: 16 * 1024 * 1024,
} as const;

const emptyLocalState: ReconciliationLocalState = {
  editingTextElement: null,
  newElement: null,
  resizingElement: null,
};

type TimingSummary = {
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
};

function measure(
  operation: () => unknown,
  beforeEach?: () => void,
): TimingSummary {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    beforeEach?.();
    operation();
  }

  const durations: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    beforeEach?.();
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);

  return {
    p50Ms: round(durations[Math.floor(durations.length * 0.5)] ?? 0),
    p95Ms: round(durations[Math.floor(durations.length * 0.95)] ?? 0),
    maxMs: round(durations.at(-1) ?? 0),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function payloadBytes(elements: readonly OrderedExcalidrawElement[]): number {
  return new TextEncoder().encode(JSON.stringify(elements)).byteLength;
}

/** Working-heap delta of one call, after a forced GC; null without gc. */
function measureWorkingHeap(operation: () => unknown): number | null {
  if (typeof global.gc !== "function") {
    return null;
  }
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const keepAlive = operation();
  const after = process.memoryUsage().heapUsed;
  if (keepAlive === undefined) {
    throw new Error("operation must return its result to survive the sample");
  }
  return Math.max(0, after - before);
}

function createRemoteDelta(
  scene: readonly OrderedExcalidrawElement[],
  size: number,
): OrderedExcalidrawElement[] {
  // Every 3rd element from the front, kept in scene (index) order — the
  // ordering contract remote batches must obey.
  return Array.from({ length: size }, (_, ordinal) =>
    editElement(scene[ordinal * 3]!, { versionNonce: 900_000 + ordinal }),
  );
}

describe("plan-10 reconciliation performance", () => {
  const results: Record<string, unknown> = {};

  it("keeps extraction payload proportional to changed elements and clone-free", () => {
    for (const sceneSize of SCENE_SIZES) {
      const scene = [...createSyncScene(sceneSize)];
      const tracker = createChangedElementTracker();
      const fullExtraction = tracker.extractChangedElements(scene, {
        now: NOW,
        syncAll: true,
      });
      fullExtraction.markSent();

      const editedIndex = Math.floor(sceneSize / 2) + 1;
      scene[editedIndex] = editElement(scene[editedIndex]!);
      const delta = tracker.extractChangedElements(scene, { now: NOW });

      // Exactly the edited element, by reference — extraction never clones.
      expect(delta.elements).toHaveLength(1);
      expect(delta.elements[0]).toBe(scene[editedIndex]);

      // A pointer-only change extracts (and would serialize) nothing.
      delta.markSent();
      expect(
        tracker.extractChangedElements(scene, { now: NOW }).elements,
      ).toEqual([]);

      const fullSceneBytes = payloadBytes(fullExtraction.elements);
      const singleEditBytes = payloadBytes(delta.elements);
      // Payload scales with changed elements, not scene size: one edited
      // element costs no more than 4x the average serialized element.
      expect(singleEditBytes * sceneSize).toBeLessThan(fullSceneBytes * 4);

      results[`payloadBytes${sceneSize}`] = {
        fullScene: fullSceneBytes,
        singleEditDelta: singleEditBytes,
        averagePerElement: Math.round(fullSceneBytes / sceneSize),
      };
    }
  });

  it("measures local change extraction at 1k/10k", () => {
    for (const sceneSize of SCENE_SIZES) {
      const scene = [...createSyncScene(sceneSize)];
      const tracker = createChangedElementTracker();
      tracker
        .extractChangedElements(scene, { now: NOW, syncAll: true })
        .markSent();

      const editedIndex = Math.floor(sceneSize / 2) + 1;
      const baseElement = scene[editedIndex]!;
      let editOrdinal = 0;

      const singleEdit = measure(
        () => tracker.extractChangedElements(scene, { now: NOW }),
        () => {
          editOrdinal += 1;
          scene[editedIndex] = editElement(baseElement, {
            version: baseElement.version + editOrdinal,
            versionNonce: editOrdinal,
          });
        },
      );
      tracker.extractChangedElements(scene, { now: NOW }).markSent();
      const noop = measure(() =>
        tracker.extractChangedElements(scene, { now: NOW }),
      );

      results[`extractSingleEdit${sceneSize}`] = singleEdit;
      results[`extractNoop${sceneSize}`] = noop;

      if (enforceBudgets && sceneSize === 10_000) {
        expect(singleEdit.p95Ms).toBeLessThanOrEqual(
          RECONCILE_PERFORMANCE_BUDGETS.extractSingleEdit10kP95Ms,
        );
        expect(noop.p95Ms).toBeLessThanOrEqual(
          RECONCILE_PERFORMANCE_BUDGETS.extractNoop10kP95Ms,
        );
      }
    }
  });

  it("measures remote reconcile at 1k/10k", { timeout: 15_000 }, () => {
    for (const sceneSize of SCENE_SIZES) {
      const scene = createSyncScene(sceneSize);
      const remoteDelta = createRemoteDelta(scene, REMOTE_DELTA_SIZE);

      const deltaReconcile = measure(() =>
        reconcileRemoteElements(scene, remoteDelta, emptyLocalState),
      );
      const sceneInit = measure(() =>
        reconcileRemoteElements([], scene, emptyLocalState),
      );
      const sceneInitRejoin = measure(() =>
        reconcileRemoteElements(scene, scene, emptyLocalState),
      );

      results[`reconcileDelta10Into${sceneSize}`] = deltaReconcile;
      results[`reconcileSceneInit${sceneSize}`] = sceneInit;
      results[`reconcileSceneInitRejoin${sceneSize}`] = sceneInitRejoin;

      if (enforceBudgets && sceneSize === 10_000) {
        expect(deltaReconcile.p95Ms).toBeLessThanOrEqual(
          RECONCILE_PERFORMANCE_BUDGETS.reconcileDelta10Into10kP95Ms,
        );
        expect(sceneInit.p95Ms).toBeLessThanOrEqual(
          RECONCILE_PERFORMANCE_BUDGETS.reconcileSceneInit10kP95Ms,
        );
      }
    }
  });

  it("measures allocation of one extraction and one reconcile at 1k/10k", () => {
    for (const sceneSize of SCENE_SIZES) {
      const scene = [...createSyncScene(sceneSize)];
      const tracker = createChangedElementTracker();
      tracker
        .extractChangedElements(scene, { now: NOW, syncAll: true })
        .markSent();
      const editedIndex = Math.floor(sceneSize / 2) + 1;
      scene[editedIndex] = editElement(scene[editedIndex]!);

      const extractionHeap = measureWorkingHeap(() =>
        tracker.extractChangedElements(scene, { now: NOW }),
      );
      const remoteDelta = createRemoteDelta(scene, REMOTE_DELTA_SIZE);
      const reconcileHeap = measureWorkingHeap(() =>
        reconcileRemoteElements(scene, remoteDelta, emptyLocalState),
      );

      results[`workingHeapDeltaBytes${sceneSize}`] = {
        extractSingleEdit: extractionHeap,
        reconcileDelta10: reconcileHeap,
      };

      expect(extractionHeap).not.toBeNull();
      expect(reconcileHeap).not.toBeNull();
      if (enforceBudgets && sceneSize === 10_000) {
        expect(extractionHeap!).toBeLessThanOrEqual(
          RECONCILE_PERFORMANCE_BUDGETS.extractionWorkingHeapDeltaBytes,
        );
        expect(reconcileHeap!).toBeLessThanOrEqual(
          RECONCILE_PERFORMANCE_BUDGETS.reconcile10kWorkingHeapDeltaBytes,
        );
      }
    }
  });

  it("prints the captured measurements", () => {
    process.stdout.write(
      `plan-10-reconcile-performance ${JSON.stringify(
        {
          budgets: RECONCILE_PERFORMANCE_BUDGETS,
          budgetEnforced: enforceBudgets,
          iterations: ITERATIONS,
          warmupIterations: WARMUP_ITERATIONS,
          results,
        },
        null,
        2,
      )}\n`,
    );
    expect(Object.keys(results).length).toBeGreaterThan(0);
  });
});
