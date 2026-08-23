import { afterEach, expect, it } from "vitest";

import {
  decodeBase64,
  encodeBase64,
  forceBase64ImplementationForTesting,
} from "../src/base64.ts";
import { hostHasNativeBase64, seededBytes } from "../tests/base64-vectors.ts";

/**
 * Plan 08 P4 evidence: p50/p95/max for 4 MiB Base64 encode/decode on this
 * host, measured against the production codec — the same functions the
 * snapshot store calls every 30-second cadence tick. Results are recorded in
 * `docs/performance/collaboration-slo-capacity.md`; the acceptance gates
 * (50 ms p95 in current browsers, native faster than fallback, fallback
 * within 10% of the pre-change baseline) are evaluated there, not asserted
 * here, because they are same-machine budgets rather than CI invariants.
 *
 * `baseline-replica` is a verbatim copy of the pre-Plan-08 snapshot-store
 * helper — the one measurement that cannot call production code, because the
 * plan replaced it; it exists so the regression gate has a same-run baseline.
 */

const FIXTURE_BYTES = 4 * 1_048_576;
const FIXTURE_SEED = 0xd7a05f;
const WARMUP = 3;
const ITERATIONS = 30;

// --- baseline replica (pre-change apps/web snapshot-store helper, verbatim) ---
const BASE64_CHUNK_BYTES = 8192;

const baselineToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
    );
  }
  return btoa(binary);
};

const baselineFromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
// --- end baseline replica ---

type HeapSampler = { method: string; sample: () => number | null };

const heapSampler = (): HeapSampler => {
  const host = globalThis as {
    gc?: () => void;
    process?: { memoryUsage?: () => { heapUsed: number } };
  };
  if (typeof host.process?.memoryUsage === "function") {
    const memoryUsage = host.process.memoryUsage.bind(host.process);
    const gc = typeof host.gc === "function" ? host.gc.bind(host) : null;
    return {
      method: gc
        ? "node process.memoryUsage().heapUsed after explicit gc"
        : "node process.memoryUsage().heapUsed (no --expose-gc; delta is best-effort)",
      sample: () => {
        gc?.();
        return memoryUsage().heapUsed;
      },
    };
  }
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  if (perf.memory) {
    return {
      method: "performance.memory.usedJSHeapSize (Chromium, best-effort)",
      sample: () => perf.memory?.usedJSHeapSize ?? null,
    };
  }
  return { method: "unavailable on this host", sample: () => null };
};

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

type Stats = { p50: number; p95: number; max: number };

const measure = (run: () => void): Stats => {
  for (let index = 0; index < WARMUP; index += 1) run();
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: quantile(samples, 0.5),
    p95: quantile(samples, 0.95),
    max: samples[samples.length - 1] ?? 0,
  };
};

const runtime = (): string => {
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent;
  }
  const host = globalThis as { process?: { version?: string } };
  return `node ${host.process?.version ?? "unknown"}`;
};

/**
 * Writes the report next to this file as `results.<host>.json` (gitignored):
 * the runner does not reliably forward console output, and the report is the
 * whole point of the run.
 */
const persistReport = async (report: unknown): Promise<void> => {
  const json = JSON.stringify(report, null, 2);
  const host = globalThis as { process?: { versions?: { node?: string } } };
  if (host.process?.versions?.node) {
    const nodeFs = await import("node:fs");
    const nodeUrl = await import("node:url");
    const nodePath = await import("node:path");
    const here = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    nodeFs.writeFileSync(nodePath.join(here, "results.node.json"), `${json}\n`);
    return;
  }
  const { commands, server } = await import("@vitest/browser/context");
  await commands.writeFile(`bench/results.${server.browser}.json`, `${json}\n`);
};

afterEach(() => {
  forceBase64ImplementationForTesting(null);
});

it("measures 4 MiB base64 encode/decode on this host", async () => {
  const fixture = seededBytes(FIXTURE_BYTES, FIXTURE_SEED);
  const encoded = encodeBase64(fixture);
  // Sanity: the codec being measured is the codec being trusted.
  const roundTrip = decodeBase64(encoded, { maxBytes: FIXTURE_BYTES });
  expect(roundTrip.ok && roundTrip.bytes.byteLength).toBe(FIXTURE_BYTES);

  const nativeAvailable = hostHasNativeBase64();
  const variants: ReadonlyArray<{
    label: string;
    force: "native" | "fallback" | null;
  }> = [
    { label: "production-selected", force: null },
    ...(nativeAvailable
      ? [{ label: "forced-native", force: "native" as const }]
      : []),
    { label: "forced-fallback", force: "fallback" as const },
  ];

  const heap = heapSampler();
  const heapBefore = heap.sample();
  let heapPeak = heapBefore ?? 0;
  const sampleHeapPeak = (): void => {
    const current = heap.sample();
    if (current !== null && current > heapPeak) heapPeak = current;
  };

  const results = variants.map(({ label, force }) => {
    forceBase64ImplementationForTesting(force);
    const encode = measure(() => {
      encodeBase64(fixture);
    });
    sampleHeapPeak();
    const decode = measure(() => {
      decodeBase64(encoded, { maxBytes: FIXTURE_BYTES });
    });
    sampleHeapPeak();
    forceBase64ImplementationForTesting(null);
    return { label, encodeMs: encode, decodeMs: decode };
  });

  const baseline = {
    label: "baseline-replica (pre-change chunked helper)",
    encodeMs: measure(() => {
      baselineToBase64(fixture);
    }),
    decodeMs: measure(() => {
      baselineFromBase64(encoded);
    }),
  };
  sampleHeapPeak();
  const heapAfter = heap.sample();

  const report = {
    plan: "08-collaboration-base64-codec P4",
    runtime: runtime(),
    inputBytes: FIXTURE_BYTES,
    encodedLength: encoded.length,
    fixtureSeed: FIXTURE_SEED,
    warmup: WARMUP,
    iterations: ITERATIONS,
    nativeCapabilityPresent: nativeAvailable,
    productionSelectedPath: nativeAvailable ? "native" : "fallback",
    results: [...results, baseline],
    heap: {
      method: heap.method,
      beforeBytes: heapBefore,
      afterBytes: heapAfter,
      peakBytes: heapBefore === null ? null : heapPeak,
      retainedDeltaBytes:
        heapBefore !== null && heapAfter !== null
          ? heapAfter - heapBefore
          : null,
    },
  };
  await persistReport(report);
});
