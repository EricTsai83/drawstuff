import { describe, expect, it } from "vitest";

import {
  createSubjectRateLimiter,
  DEFAULT_MAX_TRACKED_SUBJECTS,
} from "../src/rate-limit.ts";

/**
 * The relay-owned join-attempt limiter. The per-connection buckets and the
 * approved default budgets moved to `@drawstuff/collaboration/rate-limit`
 * (shared with the Durable Object room runtime) and are tested there; what
 * stays relay-local is the subject-keyed limiter, because keyed state that
 * outlives a connection would otherwise be the exhaustion vector the limiter
 * exists to prevent (repo rule 5).
 */

const manualClock = (start = 0) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe("createSubjectRateLimiter", () => {
  it("budgets each subject independently", () => {
    const clock = manualClock();
    const limiter = createSubjectRateLimiter({
      attemptsPerMinute: 60,
      burst: 2,
      now: clock.now,
    });

    expect(limiter.admitJoin("user-a")).toBe(true);
    expect(limiter.admitJoin("user-a")).toBe(true);
    expect(limiter.admitJoin("user-a")).toBe(false);
    expect(limiter.admitJoin("user-b")).toBe(true);
  });

  it("drops entries once their budget has refilled", () => {
    const clock = manualClock();
    const limiter = createSubjectRateLimiter({
      attemptsPerMinute: 60,
      burst: 2,
      now: clock.now,
    });
    limiter.admitJoin("user-a");
    expect(limiter.size()).toBe(1);

    // A fully refilled bucket carries no information, so keeping it would be
    // pure retention. Eviction runs on the next unseen subject.
    clock.advance(60_000);
    limiter.admitJoin("user-b");
    expect(limiter.size()).toBe(1);
    expect(limiter.admitJoin("user-a")).toBe(true);
  });

  it("fails open rather than locking everyone out when the map is full", () => {
    const clock = manualClock();
    const limiter = createSubjectRateLimiter({
      attemptsPerMinute: 60,
      burst: 1,
      maxTrackedSubjects: 2,
      now: clock.now,
    });

    expect(limiter.admitJoin("user-a")).toBe(true);
    expect(limiter.admitJoin("user-b")).toBe(true);
    expect(limiter.size()).toBe(2);

    // Beyond the cap the limiter admits instead of refusing. Refusing would let
    // one attacker's key churn deny service to every legitimate subject — the
    // limiter would become the outage it exists to prevent.
    expect(limiter.admitJoin("user-c")).toBe(true);
    expect(limiter.admitJoin("user-c")).toBe(true);
    expect(limiter.size()).toBe(2);

    // Tracked subjects are still enforced while the cap is engaged.
    expect(limiter.admitJoin("user-a")).toBe(false);
  });

  it("sizes its default entry cap above the relay connection cap", () => {
    // The cap must never engage under legitimate load: a full relay is 256
    // connections, so 256 distinct subjects has to fit with room to spare.
    expect(DEFAULT_MAX_TRACKED_SUBJECTS).toBeGreaterThan(256);
  });
});
