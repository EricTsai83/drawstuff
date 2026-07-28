import { describe, expect, it, vi } from "vitest";
import { OwnedPerformanceMonitor } from "@drawstuff/whiteboard";

describe("owned whiteboard performance monitor", () => {
  it("measures every input sample at the first consuming paint", () => {
    const emit = vi.fn();
    const monitor = new OwnedPerformanceMonitor(emit);
    monitor.begin("move", 10_000);
    monitor.recordInput(10);
    monitor.recordInput(15);
    monitor.recordFrame(20, 100, 0.75);
    monitor.recordFrame(36, 100, 0.8);
    monitor.recordFrame(52, 100, 0.9);
    monitor.end();

    expect(emit).toHaveBeenCalledWith({
      gesture: "move",
      totalElements: 10_000,
      visibleElements: 100,
      frameTimeP50: 16,
      frameTimeP95: 16,
      frameTimeP99: 16,
      inputLatencyP95: 10,
      rasterCacheHitRate: 0.9,
      longTaskCount: 0,
    });
    expect(monitor.getDiagnostics()).toEqual({
      insufficientFrameSamples: false,
      frameSampleCount: 2,
      inputSampleCount: 2,
      maxLongTaskDuration: 0,
    });
  });

  it("marks undersampled gestures instead of emitting zero-millisecond success", () => {
    const emit = vi.fn();
    const monitor = new OwnedPerformanceMonitor(emit);
    monitor.begin("pan", 50);
    monitor.recordFrame(10, 20, 0);
    monitor.end();

    expect(emit).not.toHaveBeenCalled();
    expect(monitor.getDiagnostics()).toMatchObject({
      insufficientFrameSamples: true,
      frameSampleCount: 0,
    });
  });
});
