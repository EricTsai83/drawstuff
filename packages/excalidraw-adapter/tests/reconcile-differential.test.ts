// @vitest-environment jsdom

/**
 * Differential reconciliation suite against `@excalidraw/excalidraw@0.18.1`.
 *
 * Every fixture case runs twice — once through the raw upstream composition
 * (`restoreElements` + `reconcileElements`) and once through the adapter's
 * `reconcileRemoteElements` — and the *full* semantic results must be
 * identical, proving the adapter adds no second merge algorithm. The
 * summarized results are additionally pinned in the fixture file, so an
 * upstream upgrade that changes conflict resolution fails here and forces a
 * re-audit (`RECONCILE_FIXTURE_PRINT=1 pnpm --filter
 * @drawstuff/excalidraw-adapter test` prints the new actuals).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import { describe, expect, it } from "vitest";

import {
  createChangedElementTracker,
  reconcileRemoteElements,
  type ReconciliationLocalState,
} from "../src/reconcile";
import { createSyncScene, editElement } from "./support/reconcile-scenes";

type FixtureElementPatch = Record<string, unknown> & {
  id: string;
  index: string;
};

type FixtureLocalState = {
  editingTextElementId?: string;
  newElementId?: string;
  resizingElementId?: string;
};

type ElementSummary = {
  backgroundColor: unknown;
  id: string;
  index: unknown;
  isDeleted: unknown;
  version: unknown;
  versionNonce: unknown;
};

type DifferentialFixture = {
  baseElement: Record<string, unknown>;
  cases: readonly {
    description: string;
    expected: readonly ElementSummary[];
    local: readonly FixtureElementPatch[];
    localState?: FixtureLocalState;
    name: string;
    remote: readonly FixtureElementPatch[];
    /**
     * Upstream index repair regenerates `versionNonce` (random) and
     * `updated` (wall clock); cases that trigger it normalize both volatile
     * fields to -1 on every element whose versionNonce no longer matches an
     * input, before any comparison.
     */
    volatileVersionNonce?: boolean;
  }[];
  engine: string;
  engineVersion: string;
  fixtureFormatVersion: number;
};

const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "fixtures/excalidraw-0.18.1/reconcile-differential.json",
    ),
    "utf8",
  ),
) as DifferentialFixture;

const requireFromTest = createRequire(import.meta.url);

const materializeElements = (
  patches: readonly FixtureElementPatch[],
): OrderedExcalidrawElement[] =>
  patches.map(
    (patch) =>
      ({
        ...fixture.baseElement,
        ...patch,
      }) as unknown as OrderedExcalidrawElement,
  );

const materializeLocalState = (
  localState: FixtureLocalState | undefined,
): ReconciliationLocalState => ({
  editingTextElement: localState?.editingTextElementId
    ? ({
        id: localState.editingTextElementId,
      } as unknown as AppState["editingTextElement"])
    : null,
  newElement: localState?.newElementId
    ? ({ id: localState.newElementId } as unknown as AppState["newElement"])
    : null,
  resizingElement: localState?.resizingElementId
    ? ({
        id: localState.resizingElementId,
      } as unknown as AppState["resizingElement"])
    : null,
});

const runUpstreamComposition = (
  localElements: readonly OrderedExcalidrawElement[],
  remoteElements: readonly ExcalidrawElement[],
  localState: ReconciliationLocalState,
): readonly OrderedExcalidrawElement[] =>
  reconcileElements(
    localElements,
    restoreElements(remoteElements, null) as RemoteExcalidrawElement[],
    localState as AppState,
  );

const summarize = (
  elements: readonly OrderedExcalidrawElement[],
): ElementSummary[] =>
  elements.map((element) => ({
    backgroundColor: element.backgroundColor,
    id: element.id,
    index: element.index,
    isDeleted: element.isDeleted,
    version: element.version,
    versionNonce: element.versionNonce,
  }));

describe("reconcile entry surface", () => {
  it("exposes only the narrow reconciliation contract", async () => {
    // Runtime pin (needs jsdom, so it lives here instead of the package
    // contract suite): the entry stays a narrow boundary, not an upstream
    // re-export barrel.
    const reconcileEntry =
      await import("@drawstuff/excalidraw-adapter/reconcile");

    expect(Object.keys(reconcileEntry).sort()).toEqual([
      "DELETED_ELEMENT_SYNC_TIMEOUT_MS",
      "createChangedElementTracker",
      "getSyncableElements",
      "isSyncableElement",
      "reconcileRemoteElements",
    ]);
    const tracker = reconcileEntry.createChangedElementTracker();
    expect(Object.keys(tracker).sort()).toEqual([
      "extractChangedElements",
      "markAdoptedRemoteElements",
      "reset",
    ]);
    expect(Object.keys(tracker.extractChangedElements([])).sort()).toEqual([
      "elements",
      "markSent",
    ]);
  });
});

describe("fixture version metadata", () => {
  it("matches the lockfile-resolved upstream engine version", () => {
    const upstreamEntry = requireFromTest.resolve("@excalidraw/excalidraw");
    const upstreamManifest = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(upstreamEntry), "../../package.json"),
        "utf8",
      ),
    ) as { name: string; version: string };

    expect(upstreamManifest.name).toBe(fixture.engine);
    expect(upstreamManifest.version).toBe(fixture.engineVersion);
    expect(fixture.fixtureFormatVersion).toBe(1);
  });
});

describe("adapter vs upstream differential results", () => {
  const printedSummaries: Record<string, ElementSummary[]> = {};

  it.each(fixture.cases)("$name", (differentialCase) => {
    const localState = materializeLocalState(differentialCase.localState);
    const inputNonces = new Set(
      [...differentialCase.local, ...differentialCase.remote].map(
        (patch) => `${patch.id}:${String(patch.versionNonce)}`,
      ),
    );
    const normalizeVolatile = (
      elements: readonly OrderedExcalidrawElement[],
    ): readonly OrderedExcalidrawElement[] =>
      differentialCase.volatileVersionNonce
        ? elements.map((element) =>
            inputNonces.has(`${element.id}:${element.versionNonce}`)
              ? element
              : {
                  ...element,
                  updated: -1,
                  versionNonce: -1,
                },
          )
        : elements;

    // Clone per run: upstream reconciliation may repair fractional indices
    // in place, so the two runs must never share element objects.
    const adapterResult = normalizeVolatile(
      reconcileRemoteElements(
        structuredClone(materializeElements(differentialCase.local)),
        structuredClone(materializeElements(differentialCase.remote)),
        localState,
      ),
    );
    const upstreamResult = normalizeVolatile(
      runUpstreamComposition(
        structuredClone(materializeElements(differentialCase.local)),
        structuredClone(materializeElements(differentialCase.remote)),
        localState,
      ),
    );

    // Full semantic comparison — every field of every element, in order.
    expect(adapterResult).toEqual(upstreamResult);

    if (process.env.RECONCILE_FIXTURE_PRINT === "1") {
      printedSummaries[differentialCase.name] = summarize(adapterResult);
      return;
    }
    expect(summarize(adapterResult)).toEqual(differentialCase.expected);
  });

  it("prints actual summaries when regenerating the fixture", () => {
    if (process.env.RECONCILE_FIXTURE_PRINT === "1") {
      process.stdout.write(`${JSON.stringify(printedSummaries, null, 2)}\n`);
    }
    expect(true).toBe(true);
  });
});

describe("delivery-order and duplicate-delivery convergence", () => {
  const emptyLocalState = materializeLocalState(undefined);
  const baseScene = (): OrderedExcalidrawElement[] =>
    structuredClone(createSyncScene(40));

  const remoteBatchA = (): OrderedExcalidrawElement[] => {
    const scene = baseScene();
    return [editElement(scene[3]!, { versionNonce: 901 })];
  };
  const remoteBatchB = (): OrderedExcalidrawElement[] => {
    const scene = baseScene();
    return [
      editElement(scene[3]!, {
        version: scene[3]!.version + 2,
        versionNonce: 902,
      }),
      editElement(scene[7]!, { isDeleted: true, versionNonce: 903 }),
    ];
  };

  it("converges to the same scene regardless of batch arrival order", () => {
    const viaAThenB = reconcileRemoteElements(
      reconcileRemoteElements(baseScene(), remoteBatchA(), emptyLocalState),
      remoteBatchB(),
      emptyLocalState,
    );
    const viaBThenA = reconcileRemoteElements(
      reconcileRemoteElements(baseScene(), remoteBatchB(), emptyLocalState),
      remoteBatchA(),
      emptyLocalState,
    );

    expect(viaAThenB).toEqual(viaBThenA);
  });

  it("treats duplicate delivery of the same batch as a no-op", () => {
    const once = reconcileRemoteElements(
      baseScene(),
      remoteBatchB(),
      emptyLocalState,
    );
    const twice = reconcileRemoteElements(
      once,
      remoteBatchB(),
      emptyLocalState,
    );

    expect(twice).toEqual(once);
  });
});

describe("two-client convergence through extraction and reconciliation", () => {
  const emptyLocalState = materializeLocalState(undefined);

  it("cross-applying extracted deltas converges both scenes without echo", () => {
    const now = 1_710_000_100_000;
    const sceneA = structuredClone(createSyncScene(40));
    const sceneB = structuredClone(sceneA);
    const trackerA = createChangedElementTracker();
    const trackerB = createChangedElementTracker();

    // Both clients start in sync: prime the trackers with a committed full
    // extraction (scene-init sent and accepted).
    trackerA.extractChangedElements(sceneA, { now, syncAll: true }).markSent();
    trackerB.extractChangedElements(sceneB, { now, syncAll: true }).markSent();

    // Client A edits element 5; client B edits element 11 and deletes 21.
    sceneA[5] = editElement(sceneA[5]!, { versionNonce: 555 });
    sceneB[11] = editElement(sceneB[11]!, { versionNonce: 111 });
    sceneB[21] = editElement(sceneB[21]!, {
      isDeleted: true,
      versionNonce: 212,
    });

    const batchA = trackerA.extractChangedElements(sceneA, { now });
    const batchB = trackerB.extractChangedElements(sceneB, { now });
    const deltaA = batchA.elements;
    const deltaB = batchB.elements;
    expect(deltaA.map((element) => element.id)).toEqual([sceneA[5].id]);
    expect(deltaB.map((element) => element.id)).toEqual([
      sceneB[11].id,
      sceneB[21].id,
    ]);
    // Both sends are accepted by the transport, so both batches commit.
    batchA.markSent();
    batchB.markSent();

    const mergedA = reconcileRemoteElements(sceneA, deltaB, emptyLocalState);
    trackerA.markAdoptedRemoteElements(mergedA, deltaB);
    const mergedB = reconcileRemoteElements(sceneB, deltaA, emptyLocalState);
    trackerB.markAdoptedRemoteElements(mergedB, deltaA);

    // Full semantic convergence, not just matching ids.
    expect(mergedA).toEqual(mergedB);

    // Adopted remote elements must not be echoed back on the next flush.
    expect(trackerA.extractChangedElements(mergedA, { now }).elements).toEqual(
      [],
    );
    expect(trackerB.extractChangedElements(mergedB, { now }).elements).toEqual(
      [],
    );
  });

  it("keeps a locally-won conflict pending for broadcast instead of marking it synced", () => {
    const now = 1_710_000_100_000;
    const scene = structuredClone(createSyncScene(10));
    const tracker = createChangedElementTracker();
    tracker.extractChangedElements(scene, { now, syncAll: true }).markSent();

    // The local client edits an element offline past the remote's version.
    scene[3] = editElement(scene[3]!, {
      version: scene[3]!.version + 5,
      versionNonce: 1,
    });

    // A stale remote update for the same element arrives and loses.
    const staleRemote = [
      editElement(scene[3], {
        version: scene[3].version - 1,
        versionNonce: 999,
      }),
    ];
    const merged = reconcileRemoteElements(scene, staleRemote, emptyLocalState);
    tracker.markAdoptedRemoteElements(merged, staleRemote);

    // The winning local element is still pending extraction.
    expect(
      tracker
        .extractChangedElements(merged, { now })
        .elements.map((el) => el.id),
    ).toEqual([scene[3].id]);
  });
});
