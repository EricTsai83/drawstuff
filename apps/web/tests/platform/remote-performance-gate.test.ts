// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_FAILURE_RATIO,
  evaluateGate,
  failureRecord,
} from "../../scripts/remote-performance-gate.mjs";

/**
 * The production latency run records a failed sample and continues instead of
 * aborting, so one dropped socket no longer voids every latency sample. These
 * pin what makes that safe: failures still fail the gate past the approved
 * ratio, and a failure record carries classification only, never content.
 */

const passing = { p95: 2000, p99: 3000 };
const run = (
  records: number,
  failures: number,
): Parameters<typeof evaluateGate>[0] => ({
  completed: true,
  requiredSamples: 200,
  records: Array.from({ length: records }, () => ({})),
  failures,
  metrics: { saveMs: passing, joinMs: passing },
});

describe("performance gate", () => {
  it("admits failures up to the approved ratio of formal attempts", () => {
    expect(MAX_FAILURE_RATIO).toBe(0.005);
    const oneFailure = run(200, 1);
    expect(evaluateGate(oneFailure)).toBe(true);
    expect(oneFailure.formalAttempts).toBe(201);
    expect(evaluateGate(run(200, 2))).toBe(false);
    expect(evaluateGate(run(200, 0))).toBe(true);
  });

  it("still requires every successful sample, completion and the latency thresholds", () => {
    expect(evaluateGate(run(199, 0))).toBe(false);
    expect(evaluateGate({ ...run(200, 0), completed: false })).toBe(false);
    expect(
      evaluateGate({
        ...run(200, 0),
        metrics: { saveMs: { p95: 3001, p99: 3000 }, joinMs: passing },
      }),
    ).toBe(false);
  });
});

describe("failure record", () => {
  it("keeps stage, statuses and socket state but no message", () => {
    const record = failureRecord(
      {
        warmup: false,
        sample: 27,
        attempt: 48,
        stage: "fanout",
        httpStatus: 200,
      },
      new Error("https://example.test/?token=secret"),
      { ownerSocketState: 3, ownerCloseCode: 1006 },
    );
    expect(record).toMatchObject({
      sample: 27,
      stage: "fanout",
      errorName: "Error",
      ownerCloseCode: 1006,
    });
    expect(typeof record.at).toBe("string");
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("names errors from a closed set and keeps schema issue codes only", () => {
    const renamed = new Error("boom");
    renamed.name = "token=secret";
    expect(failureRecord({}, renamed, {})).toMatchObject({
      errorName: "Error",
    });
    expect(failureRecord({}, "thrown text", {})).toMatchObject({
      errorName: "non-error",
    });
    const parsed = z.object({ status: z.literal("written") }).safeParse({
      status: "secret",
    });
    expect(parsed.success).toBe(false);
    const record = failureRecord({}, parsed.error, {});
    expect(record).toMatchObject({
      errorName: "ZodError",
      schemaIssueCodes: ["invalid_value"],
    });
    expect(JSON.stringify(record)).not.toContain("secret");
  });
});
