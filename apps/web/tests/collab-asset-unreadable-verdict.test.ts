import { describe, expect, it } from "vitest";

import { createUnreadableAssetVerdict } from "@/lib/collab/asset-unreadable-verdict";

const createHarness = () => {
  let reports = 0;
  let destroyed = false;
  const verdict = createUnreadableAssetVerdict({
    onAssetsUnreadable: () => {
      reports += 1;
    },
    isDestroyed: () => destroyed,
  });
  return {
    verdict,
    get reports() {
      return reports;
    },
    destroy() {
      destroyed = true;
    },
  };
};

describe("createUnreadableAssetVerdict", () => {
  it("reports once when the only batch finds nothing but undecryptable records", () => {
    const harness = createHarness();
    const { verdict } = harness;
    const fetchId = verdict.beginFetch();
    verdict.noteUndecryptableAsset();
    verdict.settleFetch(fetchId);
    expect(harness.reports).toBe(1);
  });

  it("never reports once any record in the room has opened", () => {
    const harness = createHarness();
    const { verdict } = harness;
    const fetchId = verdict.beginFetch();
    verdict.noteOpenedAsset();
    verdict.noteUndecryptableAsset();
    verdict.settleFetch(fetchId);
    expect(harness.reports).toBe(0);
  });

  it("waits for every batch in the armed cohort before judging", () => {
    const harness = createHarness();
    const { verdict } = harness;
    const first = verdict.beginFetch();
    const second = verdict.beginFetch();
    verdict.noteUndecryptableAsset();
    verdict.settleFetch(first);
    // The concurrent batch may still hold the room's only readable asset.
    expect(harness.reports).toBe(0);
    verdict.noteOpenedAsset();
    verdict.settleFetch(second);
    expect(harness.reports).toBe(0);
  });

  it("does not wait for batches started after the evidence was armed", () => {
    const harness = createHarness();
    const { verdict } = harness;
    const armedBatch = verdict.beginFetch();
    verdict.noteUndecryptableAsset();
    const laterBatch = verdict.beginFetch();
    verdict.settleFetch(armedBatch);
    // The cohort was only the armed batch, so the report does not wait for the
    // later one — a busy room must not defer the verdict forever.
    expect(harness.reports).toBe(1);
    verdict.settleFetch(laterBatch);
    expect(harness.reports).toBe(1);
  });

  it("reports at most once across repeated evidence", () => {
    const harness = createHarness();
    const { verdict } = harness;
    const first = verdict.beginFetch();
    verdict.noteUndecryptableAsset();
    verdict.settleFetch(first);
    const second = verdict.beginFetch();
    verdict.noteUndecryptableAsset();
    verdict.settleFetch(second);
    expect(harness.reports).toBe(1);
  });

  it("stays silent after destroy", () => {
    const harness = createHarness();
    const { verdict } = harness;
    const fetchId = verdict.beginFetch();
    verdict.noteUndecryptableAsset();
    harness.destroy();
    verdict.settleFetch(fetchId);
    expect(harness.reports).toBe(0);
  });
});
