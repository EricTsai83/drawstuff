import {
  createRelayMetrics,
  type RelayMetrics,
  type RelayMetricsSources,
} from "../../src/metrics.ts";
import {
  createRelayLogger,
  LOG_RECORD_ENVELOPE_FIELDS,
  LOGGABLE_FIELD_NAMES,
  type RelayLogger,
  type RelayLoggerOptions,
} from "../../src/logger.ts";

/**
 * Real metrics and a real logger for tests, differing from production only in
 * where they read state from and where the lines go.
 *
 * The instances are real on purpose: a stub would let a call site log a field the
 * type forbids, or record a close reason that never appears in the exposition,
 * and both are exactly what these tests exist to catch.
 */

/** Nothing is attached in a unit test, so every source reads empty. */
const EMPTY_SOURCES: RelayMetricsSources = {
  connections: () => 0,
  rooms: () => 0,
  roomSizes: () => [],
  sessions: () => 0,
  revocationCutoffs: () => 0,
  trackedSubjects: () => 0,
  draining: () => false,
  residentMemoryBytes: () => 0,
  heapUsedBytes: () => 0,
  droppedLogRecords: () => 0,
  rejectedLogFields: () => 0,
  limits: {
    maxConnections: 256,
    maxRooms: 128,
    maxConnectionsPerRoom: 32,
    maxTrackedSubjects: 1_024,
  },
};

export function createTestMetrics(
  sources: Partial<RelayMetricsSources> = {},
): RelayMetrics {
  return createRelayMetrics({
    sources: { ...EMPTY_SOURCES, ...sources },
  });
}

export type TestLogger = {
  logger: RelayLogger;
  /** Raw lines, for assertions about what must never appear in one. */
  lines(): readonly string[];
  /** Parsed records, for assertions about fields. */
  records(): readonly Record<string, unknown>[];
  /** Parsed records for one event name. */
  recordsOf(event: string): readonly Record<string, unknown>[];
};

export function createTestLogger(
  options: Omit<RelayLoggerOptions, "write" | "now"> = {},
): TestLogger {
  const lines: string[] = [];
  const logger = createRelayLogger({
    ...options,
    // Fixed salt so a pseudonym assertion is reproducible; production uses fresh
    // random bytes per process.
    subjectSalt: options.subjectSalt ?? Buffer.from("test-subject-salt"),
    write: (line) => {
      lines.push(line);
      // Accepted: a collector never applies backpressure, so a dropped record in
      // a test would be the logger's own bug rather than the sink's.
      return true;
    },
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });
  const parsed = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    logger,
    lines: () => lines,
    records: parsed,
    recordsOf: (event) => parsed().filter((record) => record.event === event),
  };
}

/**
 * Field names a log record may carry.
 *
 * Taken from the logger's own allowlist rather than restated here: a second copy
 * would drift, and a drifted copy makes the classification assertion pass for the
 * wrong reason.
 */
export const ALLOWED_LOG_FIELDS: readonly string[] = [
  ...LOG_RECORD_ENVELOPE_FIELDS,
  ...LOGGABLE_FIELD_NAMES,
];
