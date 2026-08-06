import { describe, expect, it, vi } from "vitest";

import { createRelayLogger } from "../src/logger.ts";
import { createTestLogger } from "./support/observability.ts";

/**
 * Plan 24: the logger is the relay's only output sink, so it is also the only
 * place where the threat model §5 classification can be violated. What is
 * asserted here is the line format an ingester parses, the level and frame
 * switches, and that a `sub` never reaches a line in the clear.
 */

const SUBJECT = "user_2abcXYZclerkSubject";

describe("relay structured logger", () => {
  it("writes one JSON object per line with timestamp, level and event", () => {
    const captured = createTestLogger();
    captured.logger.info("relay.listening", { host: "127.0.0.1", port: 3005 });

    expect(captured.lines()).toHaveLength(1);
    expect(captured.lines()[0]?.endsWith("\n")).toBe(true);
    expect(captured.records()[0]).toEqual({
      ts: "2026-08-06T00:00:00.000Z",
      level: "info",
      event: "relay.listening",
      host: "127.0.0.1",
      port: 3005,
    });
  });

  it("omits fields that were not supplied", () => {
    const captured = createTestLogger();
    captured.logger.info("relay.connection_closed", {
      closeReason: "peerClosed",
      roomId: undefined,
      sessionDurationMs: undefined,
    });
    expect(Object.keys(captured.records()[0] ?? {})).toEqual([
      "ts",
      "level",
      "event",
      "closeReason",
    ]);
  });

  it("drops records below the configured level", () => {
    const captured = createTestLogger({ level: "warn" });
    captured.logger.info("relay.join");
    captured.logger.warn("relay.join_refused");
    captured.logger.error("relay.control");
    expect(captured.records().map((record) => record.level)).toEqual([
      "warn",
      "error",
    ]);
  });

  it("suppresses per-frame records unless frame logging is enabled", () => {
    const off = createTestLogger();
    off.logger.frame({ channel: "scene", byteLength: 512 });
    expect(off.logger.logsFrames).toBe(false);
    expect(off.lines()).toEqual([]);

    // Frame logging is its own switch: enabling it without also lowering the
    // level must still produce records, or it would look enabled and write
    // nothing.
    const on = createTestLogger({ logFrames: true });
    on.logger.frame({ channel: "scene", byteLength: 512 });
    expect(on.logger.logsFrames).toBe(true);
    expect(on.records()[0]).toMatchObject({
      level: "debug",
      event: "relay.frame",
      channel: "scene",
      byteLength: 512,
    });
  });

  it("pseudonymizes a subject instead of recording it", () => {
    const captured = createTestLogger();
    const pseudonym = captured.logger.pseudonym(SUBJECT);

    expect(pseudonym).toMatch(/^[0-9a-f]{12}$/);
    expect(pseudonym).not.toContain(SUBJECT);
    expect(SUBJECT).not.toContain(pseudonym);
    // Stable within one logger, so lines about one user can be correlated.
    expect(captured.logger.pseudonym(SUBJECT)).toBe(pseudonym);
    expect(captured.logger.pseudonym(`${SUBJECT}2`)).not.toBe(pseudonym);

    captured.logger.info("relay.join", { subject: pseudonym });
    expect(captured.lines().join("")).not.toContain(SUBJECT);
  });

  it("refuses a field outside the allowlist and counts the refusal", () => {
    // The type is not the whole guard. TypeScript rejects excess properties only
    // on object *literals*, so a variable that structurally satisfies
    // `RelayLogFields` while carrying a forbidden extra property type-checks at
    // every call site. This is that variable.
    const smuggled = {
      roomId: "room-1",
      token: "eyJhbGciOi.forbidden-token-material",
    };
    const captured = createTestLogger();
    captured.logger.info("relay.join", smuggled);

    expect(captured.lines()[0]).not.toContain("forbidden-token-material");
    expect(captured.lines()[0]).not.toContain("token");
    expect(captured.records()[0]).toEqual({
      ts: "2026-08-06T00:00:00.000Z",
      level: "info",
      event: "relay.join",
      roomId: "room-1",
    });
    // Counted, not silently swallowed: a rejected field is a code defect, and
    // `relay_log_fields_rejected_total` is how it becomes visible.
    expect(captured.logger.rejectedFields()).toBe(1);
  });

  it("drops records instead of queueing them when the sink is backed up", () => {
    // Stands in for a stalled log collector: `process.stdout.write` returning
    // false is the signal that Node has started queueing in memory, and the
    // policy is to drop rather than grow that queue without bound.
    const accepted: string[] = [];
    let backedUp = false;
    const logger = createRelayLogger({
      write: (line) => {
        if (backedUp) return false;
        accepted.push(line);
        return true;
      },
    });

    logger.info("relay.join");
    backedUp = true;
    logger.info("relay.join");
    logger.info("relay.connection_closed");

    expect(accepted).toHaveLength(1);
    expect(logger.droppedRecords()).toBe(2);
  });

  it("stops writing to stdout while it is backed up and resumes on drain", () => {
    // The default sink is the one that implements the bounded-queue rule, so it
    // has to be exercised directly: a test that injects its own sink passes even
    // if this policy is deleted.
    const written: string[] = [];
    let accepting = false;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        // false is Node's "the buffer is full, further writes are queued in
        // memory" signal.
        return accepting;
      });
    const drainListenersBefore = process.stdout.listenerCount("drain");
    try {
      const logger = createRelayLogger();

      // The line that discovers the backpressure is still written; it is the cap
      // on the queue, not an exception to it.
      logger.info("relay.join");
      expect(written).toHaveLength(1);
      expect(logger.droppedRecords()).toBe(0);

      // Everything after it is dropped rather than handed to a stalled stream.
      logger.info("relay.join");
      logger.info("relay.connection_closed");
      expect(written).toHaveLength(1);
      expect(logger.droppedRecords()).toBe(2);

      // Exactly one listener, so a long backpressure episode cannot accumulate
      // them.
      expect(process.stdout.listenerCount("drain")).toBe(
        drainListenersBefore + 1,
      );

      accepting = true;
      process.stdout.emit("drain");
      logger.info("relay.join");
      expect(written).toHaveLength(2);
      expect(logger.droppedRecords()).toBe(2);
      expect(process.stdout.listenerCount("drain")).toBe(drainListenersBefore);
    } finally {
      write.mockRestore();
    }
  });

  it("keys pseudonyms per process, so they do not correlate across restarts", () => {
    // A fresh salt per process is the point: it satisfies "never the raw id" and
    // additionally makes the pseudonym unlinkable across relay restarts and
    // impossible to dictionary-attack back to a user id.
    const first = createRelayLogger({ write: () => true });
    const second = createRelayLogger({ write: () => true });
    expect(first.pseudonym(SUBJECT)).not.toBe(second.pseudonym(SUBJECT));
  });
});
