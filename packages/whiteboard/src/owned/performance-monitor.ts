import type { WhiteboardPerformanceSample } from "../contracts";

type PerformanceGesture = WhiteboardPerformanceSample["gesture"];

export class OwnedPerformanceMonitor {
  private gesture: PerformanceGesture | null = null;
  private totalElements = 0;
  private visibleElements = 0;
  private readonly frameTimes: number[] = [];
  private readonly inputLatencies: number[] = [];
  private readonly pendingInputTimestamps: number[] = [];
  private lastFrameAt: number | null = null;
  private longTaskCount = 0;
  private maxLongTaskDuration = 0;
  private rasterCacheHitRate = 0;
  private lastDiagnostics = {
    insufficientFrameSamples: true,
    frameSampleCount: 0,
    inputSampleCount: 0,
    maxLongTaskDuration: 0,
  };
  private readonly observer: PerformanceObserver | null;

  public constructor(
    private readonly emit: (sample: WhiteboardPerformanceSample) => void,
  ) {
    this.observer =
      typeof PerformanceObserver === "undefined"
        ? null
        : new PerformanceObserver((list) => {
            if (!this.gesture) return;
            for (const entry of list.getEntries()) {
              if (entry.duration <= 50) continue;
              this.longTaskCount += 1;
              this.maxLongTaskDuration = Math.max(
                this.maxLongTaskDuration,
                entry.duration,
              );
            }
          });
    try {
      this.observer?.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer?.disconnect();
    }
  }

  public begin(gesture: PerformanceGesture, totalElements: number): void {
    if (this.gesture && this.gesture !== gesture) this.end();
    if (this.gesture === gesture) return;
    this.gesture = gesture;
    this.totalElements = totalElements;
    this.visibleElements = 0;
    this.frameTimes.length = 0;
    this.inputLatencies.length = 0;
    this.pendingInputTimestamps.length = 0;
    this.lastFrameAt = null;
    this.longTaskCount = 0;
    this.maxLongTaskDuration = 0;
    this.rasterCacheHitRate = 0;
  }

  public recordInput(timestamp: number): void {
    if (!this.gesture || !Number.isFinite(timestamp)) return;
    this.pendingInputTimestamps.push(timestamp);
  }

  public recordFrame(
    timestamp: number,
    visibleElements: number,
    rasterCacheHitRate: number,
  ): void {
    if (!this.gesture || !Number.isFinite(timestamp)) return;
    if (this.lastFrameAt !== null) {
      this.frameTimes.push(Math.max(0, timestamp - this.lastFrameAt));
    }
    for (const inputTimestamp of this.pendingInputTimestamps) {
      if (timestamp >= inputTimestamp) {
        this.inputLatencies.push(timestamp - inputTimestamp);
      }
    }
    this.pendingInputTimestamps.length = 0;
    this.visibleElements = visibleElements;
    this.rasterCacheHitRate = clampRate(rasterCacheHitRate);
    this.lastFrameAt = timestamp;
  }

  public end(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.lastDiagnostics = {
      insufficientFrameSamples: this.frameTimes.length < 2,
      frameSampleCount: this.frameTimes.length,
      inputSampleCount: this.inputLatencies.length,
      maxLongTaskDuration: this.maxLongTaskDuration,
    };
    if (this.frameTimes.length < 2) return;
    this.emit({
      gesture,
      totalElements: this.totalElements,
      visibleElements: this.visibleElements,
      frameTimeP50: percentile(this.frameTimes, 0.5),
      frameTimeP95: percentile(this.frameTimes, 0.95),
      frameTimeP99: percentile(this.frameTimes, 0.99),
      inputLatencyP95: percentile(this.inputLatencies, 0.95),
      rasterCacheHitRate: this.rasterCacheHitRate,
      longTaskCount: this.longTaskCount,
    });
  }

  public destroy(): void {
    this.observer?.disconnect();
    this.gesture = null;
  }

  public getDiagnostics(): {
    readonly insufficientFrameSamples: boolean;
    readonly frameSampleCount: number;
    readonly inputSampleCount: number;
    readonly maxLongTaskDuration: number;
  } {
    return this.lastDiagnostics;
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

function clampRate(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
