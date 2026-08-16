import { describe, expect, it } from "vitest";

import {
  classifyDisconnect,
  createRecoveryMachine,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  reconnectDelayMs,
  type RecoveryMachine,
} from "../src/recovery.ts";
import type { DisconnectReason } from "../src/transport.ts";
import { createSeededRandom } from "../src/testing.ts";

/** Machine with deterministic jitter and a small budget for readable numbers. */
const machineWith = (
  overrides: Parameters<typeof createRecoveryMachine>[0] = {},
): RecoveryMachine =>
  createRecoveryMachine({
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    maxAttempts: 3,
    // Mid-range jitter, so an equal-jitter delay is exactly 3/4 of the cap.
    random: () => 0.5,
    // Zero window means any resolved baseline clears the budget, so the tests
    // that are not about live stability keep their legacy arithmetic; the
    // stability tests below override this with an explicit clock.
    liveStabilityMs: 0,
    ...overrides,
  });

/** Drives one full attempt to `live`. */
const reachLive = (machine: RecoveryMachine): void => {
  machine.start();
  machine.connected();
  machine.synced();
};

describe("classifyDisconnect", () => {
  it("retries the reasons a later attempt can succeed on", () => {
    expect(classifyDisconnect("transient")).toEqual({ action: "retry" });
    // A refused token is usually an expired one; the next attempt mints a fresh
    // one, and a genuinely removed member is stopped at the backend instead.
    expect(classifyDisconnect("unauthorized")).toEqual({ action: "retry" });
    // Retried despite the name. The relay closes with this code whenever the app
    // withdraws a socket's authorization, and *changing* a member's role does
    // exactly that in order to force a reconnect carrying the new role. Only the
    // next token request can tell a demotion from a removal, so stopping here
    // would strand every role change.
    expect(classifyDisconnect("membership-revoked")).toEqual({
      action: "retry",
    });
  });

  it("stops on the reasons a reconnect can only repeat", () => {
    expect(classifyDisconnect("room-ended")).toEqual({
      action: "stop",
      failure: "room-ended",
    });
    expect(classifyDisconnect("protocol")).toEqual({
      action: "stop",
      failure: "protocol-violation",
    });
    // Terminal for the running code: reconnecting resends the same version,
    // and only a page reload changes it.
    expect(classifyDisconnect("unsupported-protocol-version")).toEqual({
      action: "stop",
      failure: "unsupported-protocol-version",
    });
  });

  it("ignores a disconnect the caller asked for", () => {
    expect(classifyDisconnect("idle")).toEqual({ action: "ignore" });
  });

  it("classifies every reason the transport can report", () => {
    // Structural: a new `DisconnectReason` must be given a policy, not silently
    // fall through to whatever the last branch was.
    const reasons: DisconnectReason[] = [
      "idle",
      "transient",
      "unauthorized",
      "membership-revoked",
      "room-ended",
      "protocol",
      "unsupported-protocol-version",
    ];
    for (const reason of reasons) {
      expect(classifyDisconnect(reason).action).toMatch(
        /^(retry|stop|ignore)$/,
      );
    }
  });
});

describe("reconnectDelayMs", () => {
  it("grows exponentially and stops at the cap", () => {
    const delay = (attempt: number): number =>
      reconnectDelayMs({
        attempt,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        random: () => 1,
      });
    // With `random() === 1` the equal-jitter delay is the full computed value.
    expect(delay(1)).toBe(100);
    expect(delay(2)).toBe(200);
    expect(delay(3)).toBe(400);
    expect(delay(4)).toBe(800);
    expect(delay(5)).toBe(1_000);
    expect(delay(9)).toBe(1_000);
  });

  it("keeps half the delay as a floor so a recovered relay gets a gap", () => {
    // Full jitter would allow ~0ms here, which is what turns a room-wide outage
    // into a thundering herd the instant the relay comes back.
    const floored = reconnectDelayMs({
      attempt: 4,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      random: () => 0,
    });
    expect(floored).toBe(400);
  });

  it("spreads a reconnect storm across the jitter window", () => {
    const random = createSeededRandom(20260805);
    const delays = Array.from({ length: 10 }, () =>
      reconnectDelayMs({
        attempt: 5,
        baseDelayMs: DEFAULT_RECONNECT_BASE_DELAY_MS,
        maxDelayMs: DEFAULT_RECONNECT_MAX_DELAY_MS,
        random,
      }),
    );
    // Ten clients backing off together must not land on one millisecond.
    expect(new Set(delays).size).toBeGreaterThan(5);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(4_000);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });
});

describe("createRecoveryMachine", () => {
  it("starts idle and walks connecting → syncing → live", () => {
    const machine = machineWith();
    expect(machine.state()).toEqual({ phase: "idle" });

    machine.start();
    expect(machine.state()).toEqual({ phase: "connecting", attempt: 1 });
    machine.connected();
    expect(machine.state()).toEqual({ phase: "syncing", attempt: 1 });
    machine.synced();
    expect(machine.state()).toEqual({ phase: "live" });
  });

  it("schedules a backoff delay for a transient loss", () => {
    const machine = machineWith();
    reachLive(machine);

    // attempt 1 after the reset: 100ms capped, half of it plus half the jitter.
    expect(machine.lost("transient")).toEqual({
      phase: "waiting",
      attempt: 1,
      delayMs: 75,
    });
  });

  it("backs off further on each consecutive failed attempt", () => {
    const machine = machineWith({ maxAttempts: 10 });
    reachLive(machine);

    const delays: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const waiting = machine.lost("transient");
      if (waiting.phase !== "waiting") throw new Error("expected waiting");
      delays.push(waiting.delayMs);
      machine.start();
      machine.connected();
    }
    expect(delays).toEqual([75, 150, 300, 600]);
  });

  it("only a resolved baseline clears the retry budget", () => {
    const machine = machineWith({ maxAttempts: 10 });
    reachLive(machine);

    // A relay that accepts the join and drops it before the baseline arrives is
    // not progress: the delay must keep growing.
    machine.lost("transient");
    machine.start();
    machine.connected();
    const second = machine.lost("transient");
    expect(second).toMatchObject({ attempt: 2, delayMs: 150 });

    // A completed sync does clear it.
    machine.start();
    machine.connected();
    machine.synced();
    expect(machine.lost("transient")).toMatchObject({
      attempt: 1,
      delayMs: 75,
    });
  });

  it("gives up with `retry-limit` once the budget is spent", () => {
    const machine = machineWith({ maxAttempts: 3 });
    reachLive(machine);

    // Three retries are allowed; the loss that would need a fourth stops.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(machine.lost("transient")).toMatchObject({
        phase: "waiting",
        attempt,
      });
      machine.start();
    }
    expect(machine.lost("transient")).toEqual({
      phase: "failed",
      reason: "retry-limit",
    });
  });

  it("stops immediately on a terminal disconnect however much budget is left", () => {
    const machine = machineWith({
      maxAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
    });
    reachLive(machine);

    expect(machine.lost("room-ended")).toEqual({
      phase: "failed",
      reason: "room-ended",
    });
  });

  it("returns to idle when the caller ended the session", () => {
    const machine = machineWith();
    reachLive(machine);
    expect(machine.lost("idle")).toEqual({ phase: "idle" });
  });

  it("ignores a loss reported while idle or already failed", () => {
    const machine = machineWith();
    // A transport emits its final `disconnected` after the caller stopped.
    expect(machine.lost("transient")).toEqual({ phase: "idle" });

    reachLive(machine);
    machine.fail("membership-revoked");
    expect(machine.lost("transient")).toEqual({
      phase: "failed",
      reason: "membership-revoked",
    });
  });

  it("keeps the first failure reason, because the rest are consequences", () => {
    const machine = machineWith();
    reachLive(machine);
    machine.fail("unreadable-room");
    machine.fail("retry-limit");
    expect(machine.state()).toEqual({
      phase: "failed",
      reason: "unreadable-room",
    });
  });

  it("never starts another attempt once failed", () => {
    const machine = machineWith();
    reachLive(machine);
    machine.fail("room-ended");
    expect(() => machine.start()).toThrow(/not legal in phase "failed"/);
  });

  it("rejects out-of-order transitions instead of guessing", () => {
    const machine = machineWith();
    expect(() => machine.connected()).toThrow(/not legal in phase "idle"/);
    expect(() => machine.synced()).toThrow(/not legal in phase "idle"/);

    machine.start();
    expect(() => machine.start()).toThrow(/not legal in phase "connecting"/);
    expect(() => machine.synced()).toThrow(/not legal in phase "connecting"/);

    machine.connected();
    expect(() => machine.connected()).toThrow(/not legal in phase "syncing"/);

    machine.synced();
    machine.lost("transient");
    // Already waiting: a second loss would mean the driver lost track of its
    // own attempt, which must surface rather than schedule two reconnects.
    expect(() => machine.lost("transient")).toThrow(
      /not legal in phase "waiting"/,
    );
  });

  it("restarts cleanly from a failed state after `stop()`", () => {
    const machine = machineWith();
    reachLive(machine);
    machine.fail("retry-limit");
    machine.stop();
    expect(machine.state()).toEqual({ phase: "idle" });
    machine.start();
    expect(machine.state()).toEqual({ phase: "connecting", attempt: 1 });
  });

  it("rejects a policy that cannot produce a usable delay", () => {
    expect(() => createRecoveryMachine({ baseDelayMs: 0 })).toThrow(
      /baseDelayMs/,
    );
    expect(() =>
      createRecoveryMachine({ baseDelayMs: 500, maxDelayMs: 100 }),
    ).toThrow(/maxDelayMs/);
    expect(() => createRecoveryMachine({ maxAttempts: 0 })).toThrow(
      /maxAttempts/,
    );
    expect(() => createRecoveryMachine({ liveStabilityMs: -1 })).toThrow(
      /liveStabilityMs/,
    );
  });
});

/**
 * The live-stability window. A defect that reproduces right after every
 * successful baseline — e.g. a relay bug on the first post-sync frame, closed
 * with `internalError` — makes a session that syncs and dies within a second,
 * over and over. Clearing the budget on `synced()` would retry that loop
 * forever from the first backoff delay; the window makes each short-lived live
 * session keep spending one budget, so the loop ends in `retry-limit`.
 */
describe("recovery live-stability window", () => {
  const stableMachine = (now: () => number, maxAttempts = 3): RecoveryMachine =>
    machineWith({ maxAttempts, liveStabilityMs: 30_000, now });

  it("keeps spending the budget across live sessions that die inside the window", () => {
    let current = 0;
    const machine = stableMachine(() => current);

    // Each loop syncs successfully and dies one second later.
    for (let round = 1; round <= 2; round += 1) {
      machine.start();
      machine.connected();
      machine.synced();
      current += 1_000;
      // The budget was not repaid: the next attempt number keeps climbing
      // instead of restarting from 1.
      expect(machine.lost("transient")).toMatchObject({
        phase: "waiting",
        attempt: round + 1,
      });
    }

    // The third short-lived live session spends the last of the budget.
    machine.start();
    machine.connected();
    machine.synced();
    current += 1_000;
    expect(machine.lost("transient")).toEqual({
      phase: "failed",
      reason: "retry-limit",
    });
  });

  it("clears the budget once a session has stayed live past the window", () => {
    let current = 0;
    const machine = stableMachine(() => current);

    // One short-lived live session spends budget...
    machine.start();
    machine.connected();
    machine.synced();
    current += 1_000;
    expect(machine.lost("transient")).toMatchObject({ attempt: 2 });

    // ...and a stably live one repays it: the next loss backs off as a first
    // retry again, so an ordinary relay restart never accumulates history.
    machine.start();
    machine.connected();
    machine.synced();
    current += 30_000;
    expect(machine.lost("transient")).toMatchObject({
      phase: "waiting",
      attempt: 1,
      delayMs: 75,
    });
  });

  it("does not let a pre-baseline failure consult a stale live timestamp", () => {
    let current = 0;
    const machine = stableMachine(() => current, 2);

    // A stably live session, then a loss: budget repaid.
    machine.start();
    machine.connected();
    machine.synced();
    current += 60_000;
    expect(machine.lost("transient")).toMatchObject({ attempt: 1 });

    // The next attempts die before their baselines. However much time passes,
    // that is never progress — the budget must keep draining to exhaustion.
    machine.start();
    machine.connected();
    current += 60_000;
    expect(machine.lost("transient")).toMatchObject({ attempt: 2 });
    machine.start();
    current += 60_000;
    expect(machine.lost("transient")).toEqual({
      phase: "failed",
      reason: "retry-limit",
    });
  });
});
