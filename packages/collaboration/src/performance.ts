import { z } from "zod";

/** Numeric diagnostics only, on capability-authenticated requests. */
export const PERFORMANCE_PROBE_HEADER = "x-collab-performance-probe";
const metricNames = [
  "routeSession",
  "rateLimit",
  "uploadHandler",
  "session",
  "identity",
  "gateway",
  "gatewayService",
  "room",
  "register",
  "registerStorage",
  "readAssets",
  "readAssetsStorage",
  "readSnapshot",
  "readSnapshotStorage",
  "acceptContent",
  "receiveBody",
  "adapterReceiveBody",
  "settleContent",
  "write",
  "writeStorage",
  "callback",
  "storage",
] as const;
const names = new Set<string>(metricNames);
export const performanceTimingsSchema = z.partialRecord(
  z.enum(metricNames),
  z.number().finite().min(0).max(120_000),
);
export type PerformanceTimings = z.infer<typeof performanceTimingsSchema>;

export function formatServerTimings(timings: PerformanceTimings): string {
  return metricNames
    .flatMap((name) => {
      const value = timings[name];
      return typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 120_000
        ? [`${name};dur=${value.toFixed(2)}`]
        : [];
    })
    .join(", ");
}

/** Ignore malformed or unknown fields; diagnostics must not break a content receipt. */
export function readServerTimings(header: string | null): PerformanceTimings {
  const timings: PerformanceTimings = {};
  if (!header || header.length > 2048) return timings;
  for (const field of header.split(",")) {
    const match = /^\s*([a-zA-Z]+);dur=(\d+(?:\.\d+)?)\s*$/.exec(field);
    if (!match || !names.has(match[1]!)) continue;
    const value = Number(match[2]);
    if (value <= 120_000) timings[match[1] as keyof PerformanceTimings] = value;
  }
  return timings;
}
