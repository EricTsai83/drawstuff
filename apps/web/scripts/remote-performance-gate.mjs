import { z } from "zod";

// A failed sample is recorded and the run continues; the gate admits this
// share of formal attempts failing, and the run stops once it cannot pass and
// has gathered enough failures to classify.
export const MAX_FAILURE_RATIO = 0.005;
export const MAX_FAILURES = 10;

const failureErrorNames = new Set(["AssertionError", "ZodError", "TimeoutError", "AbortError", "TypeError", "SyntaxError"]);

/**
 * One failed sample: stage, statuses and socket state only, never messages or bodies.
 * @param {Record<string, unknown>} context
 * @param {unknown} error
 * @param {Record<string, unknown>} sockets
 * @returns {Record<string, unknown>}
 */
export function failureRecord(context, error, sockets) {
  const name = error instanceof Error ? error.name : typeof error;
  return {
    ...context,
    at: new Date().toISOString(),
    errorName: failureErrorNames.has(name) ? name : error instanceof Error ? "Error" : "non-error",
    ...(error instanceof z.ZodError ? { schemaIssueCodes: [...new Set(error.issues.map((issue) => issue.code))] } : {}),
    ...sockets,
  };
}

/**
 * @typedef {{ p95: number | null, p99: number | null }} Quantiles
 * @typedef {{
 *   completed: boolean, requiredSamples: number, records: unknown[], failures: number,
 *   metrics: { saveMs: Quantiles, joinMs: Quantiles },
 *   formalAttempts?: number, failureRatio?: number,
 * }} GateInput
 */

/** @param {number | null} value @param {number} limit */
const within = (value, limit) => value !== null && value <= limit;

/**
 * Latency gate over successful formal samples plus the formal failure ratio.
 * Records `formalAttempts` and `failureRatio` on the result.
 * @param {GateInput} result
 * @returns {boolean}
 */
export function evaluateGate(result) {
  const attempts = result.records.length + result.failures;
  const ratio = attempts ? result.failures / attempts : 0;
  result.formalAttempts = attempts;
  result.failureRatio = ratio;
  return result.completed && result.records.length === result.requiredSamples && ratio <= MAX_FAILURE_RATIO
    && within(result.metrics.saveMs.p95, 3000) && within(result.metrics.saveMs.p99, 8000)
    && within(result.metrics.joinMs.p95, 3000) && within(result.metrics.joinMs.p99, 5000);
}
