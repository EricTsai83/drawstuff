import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMaxMemoryWatchdog,
  MAX_RELAY_RSS_BYTES,
} from "../src/watchdog.ts";
import { createTestLogger } from "./support/observability.ts";

/**
 * Plan 25 / SLO §4.1: the max-memory watchdog reports a breach exactly once
 * and hands the decision to the drain path. The action itself (drain, exit) is
 * the caller's and is exercised by the shutdown wiring in `main.ts`.
 */

describe("max-memory watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the approved 1 GiB threshold", () => {
    expect(MAX_RELAY_RSS_BYTES).toBe(1_073_741_824);
  });

  it("stays quiet while RSS is at or under the limit", () => {
    const logs = createTestLogger();
    const onExceeded = vi.fn();
    const watchdog = createMaxMemoryWatchdog({
      logger: logs.logger,
      onExceeded,
      maxRssBytes: 1_000,
      sampleIntervalMs: 10,
      rss: () => 1_000,
    });
    vi.advanceTimersByTime(100);
    expect(onExceeded).not.toHaveBeenCalled();
    expect(logs.recordsOf("relay.memory_limit_exceeded")).toHaveLength(0);
    watchdog.stop();
  });

  it("logs the breach with both numbers and fires exactly once", () => {
    const logs = createTestLogger();
    const onExceeded = vi.fn();
    let rss = 900;
    const watchdog = createMaxMemoryWatchdog({
      logger: logs.logger,
      onExceeded,
      maxRssBytes: 1_000,
      sampleIntervalMs: 10,
      rss: () => rss,
    });
    vi.advanceTimersByTime(30);
    expect(onExceeded).not.toHaveBeenCalled();

    rss = 1_001;
    // Well past several sampling intervals: a watchdog that kept sampling
    // after the breach would fire again while the drain is still running.
    vi.advanceTimersByTime(100);
    expect(onExceeded).toHaveBeenCalledTimes(1);
    const records = logs.recordsOf("relay.memory_limit_exceeded");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      rssBytes: 1_001,
      maxRssBytes: 1_000,
    });
    watchdog.stop();
  });

  it("never fires after stop()", () => {
    const logs = createTestLogger();
    const onExceeded = vi.fn();
    const watchdog = createMaxMemoryWatchdog({
      logger: logs.logger,
      onExceeded,
      maxRssBytes: 1_000,
      sampleIntervalMs: 10,
      rss: () => 2_000,
    });
    watchdog.stop();
    vi.advanceTimersByTime(100);
    expect(onExceeded).not.toHaveBeenCalled();
  });
});
