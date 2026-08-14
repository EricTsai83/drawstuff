import { describe, expect, it } from "vitest";

import {
  MAX_EXPECTED_DISPLAY_REFRESH_HZ,
  PRESENCE_THROTTLE_MS,
  SCENE_FLUSH_BACKSTOP_MS,
} from "@drawstuff/collaboration/client-pacing";

import {
  createConnectionRateLimiter,
  createSubjectRateLimiter,
  createTokenBucket,
  DEFAULT_MAX_TRACKED_SUBJECTS,
  DEFAULT_RELAY_RATE_LIMITS,
  type ConnectionRateLimiter,
} from "../src/rate-limit.ts";

/**
 * The rate-limit primitives on their own (Plan 19 step 2). The connection-level
 * behaviour they drive is covered in `connection.test.ts`; what matters here is
 * the arithmetic and, for the subject limiter, that keyed state which outlives a
 * connection stays bounded — an unbounded map would be the exhaustion vector the
 * limiter exists to prevent (repo rule 5).
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

describe("createTokenBucket", () => {
  it("admits a full burst from idle, then refuses", () => {
    const clock = manualClock();
    const bucket = createTokenBucket({
      ratePerSecond: 10,
      burst: 3,
      now: clock.now,
    });

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills at the stated rate and never above the burst", () => {
    const clock = manualClock();
    const bucket = createTokenBucket({
      ratePerSecond: 10,
      burst: 2,
      now: clock.now,
    });
    expect(bucket.tryConsume(2)).toBe(true);

    // 10/s is one token per 100 ms.
    clock.advance(99);
    expect(bucket.tryConsume()).toBe(false);
    clock.advance(1);
    expect(bucket.tryConsume()).toBe(true);

    // A long idle period does not bank more than the burst.
    clock.advance(60_000);
    expect(bucket.tryConsume(2)).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("deducts nothing when a charge is refused", () => {
    const clock = manualClock();
    const bucket = createTokenBucket({
      ratePerSecond: 1,
      burst: 10,
      now: clock.now,
    });

    // A charge that cannot be covered must leave the budget intact, or an
    // oversized request would starve the smaller ones that follow it.
    expect(bucket.tryConsume(11)).toBe(false);
    expect(bucket.tryConsume(10)).toBe(true);
  });

  it("does not remove tokens when the clock jumps backwards", () => {
    const clock = manualClock(10_000);
    const bucket = createTokenBucket({
      ratePerSecond: 1,
      burst: 2,
      now: clock.now,
    });
    expect(bucket.tryConsume()).toBe(true);

    clock.advance(-5_000);
    // Negative elapsed time must be clamped, not applied as a debit.
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("grants no refill when the clock jumps backwards and returns", () => {
    const clock = manualClock(10_000);
    const bucket = createTokenBucket({
      ratePerSecond: 1,
      burst: 2,
      now: clock.now,
    });
    expect(bucket.tryConsume(2)).toBe(true);

    // Clamping the elapsed value alone is not enough: if the excursion lowered
    // the mark, the return would register as five freshly elapsed seconds and
    // hand out a whole burst during a clock correction.
    clock.advance(-5_000);
    expect(bucket.tryConsume()).toBe(false);
    clock.advance(5_000);
    expect(bucket.tryConsume()).toBe(false);

    // Time past the previous high-water mark still refills normally.
    clock.advance(1_000);
    expect(bucket.tryConsume()).toBe(true);
  });

  it("rejects nonsensical configuration at construction", () => {
    expect(() => createTokenBucket({ ratePerSecond: 0, burst: 1 })).toThrow(
      /ratePerSecond/,
    );
    expect(() => createTokenBucket({ ratePerSecond: 1, burst: 0 })).toThrow(
      /burst/,
    );
  });
});

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

/**
 * The budget a legitimate client must never hit. Review pass 3 found the original
 * 30 frames/s derivation wrong: `defaultScheduleSceneFlush` races
 * `requestAnimationFrame` against a 32 ms timer and takes whichever fires *first*,
 * so the timer is a backstop for a throttled tab rather than a minimum interval —
 * a continuous drag is paced by the display, not by 32 ms.
 */
describe("approved default budgets vs real client cadences", () => {
  const clock = () => {
    let current = 0;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
    };
  };

  /** Runs `seconds` of traffic at `framesPerSecond`, one frame per tick. */
  const sustain = (
    limiter: ConnectionRateLimiter,
    tick: { advance: (ms: number) => void },
    options: {
      channel: "scene" | "presence";
      framesPerSecond: number;
      seconds: number;
      byteLength: number;
    },
  ): boolean => {
    const intervalMs = 1_000 / options.framesPerSecond;
    const total = options.framesPerSecond * options.seconds;
    for (let frame = 0; frame < total; frame += 1) {
      if (!limiter.admitFrame(options.channel, options.byteLength))
        return false;
      tick.advance(intervalMs);
    }
    return true;
  };

  it("admits ten seconds of 120 Hz editing", () => {
    const tick = clock();
    const limiter = createConnectionRateLimiter({
      limits: DEFAULT_RELAY_RATE_LIMITS,
      now: tick.now,
    });

    // 120 Hz is the fastest display cadence a legitimate client can be paced by,
    // and a normal delta is ~0.5 KB. Ten seconds of it must not trip anything —
    // the original 30/s budget closed the connection after about two.
    expect(
      sustain(limiter, tick, {
        channel: "scene",
        framesPerSecond: 120,
        seconds: 10,
        byteLength: 512,
      }),
    ).toBe(true);
  });

  it("admits ten seconds of presence at the client's throttle", () => {
    const tick = clock();
    const limiter = createConnectionRateLimiter({
      limits: DEFAULT_RELAY_RATE_LIMITS,
      now: tick.now,
    });

    // The client throttles presence to one sample per 33 ms ≈ 30/s.
    expect(
      sustain(limiter, tick, {
        channel: "presence",
        framesPerSecond: 31,
        seconds: 10,
        byteLength: 256,
      }),
    ).toBe(true);
  });

  it("absorbs a newcomer join storm of full scenes", () => {
    const tick = clock();
    const limiter = createConnectionRateLimiter({
      limits: DEFAULT_RELAY_RATE_LIMITS,
      now: tick.now,
    });

    // Membership arrives one event per peer, so the elected responder broadcasts
    // one full scene per newcomer. Eight near-maximum scenes inside half a second
    // is the spike the burst has to cover.
    for (let reply = 0; reply < 8; reply += 1) {
      expect(limiter.admitFrame("scene", 1_000_000)).toBe(true);
      tick.advance(60);
    }
  });

  it("still refuses a flood well past any display cadence", () => {
    const tick = clock();
    const limiter = createConnectionRateLimiter({
      limits: DEFAULT_RELAY_RATE_LIMITS,
      now: tick.now,
    });

    // The frame budget is not there to shape legitimate cadence — the byte budget
    // bounds resources. What it stops is a flood of tiny frames, each of which
    // still costs a fanout iteration across up to 32 members.
    expect(
      sustain(limiter, tick, {
        channel: "scene",
        framesPerSecond: 2_000,
        seconds: 2,
        byteLength: 8,
      }),
    ).toBe(false);
  });
});

/**
 * Plan 07 L5: the default budgets encode assumptions about how fast the client
 * *sends*, and those assumptions used to live only in prose. Pinning the
 * budgets to the shared client-pacing constants makes a client pacing change
 * fail here instead of silently loosening or over-tightening the budgets.
 */
describe("default budgets against the client pacing contract", () => {
  it("keeps the presence budget ahead of the client presence cadence", () => {
    const clientPresencePerSecond = 1_000 / PRESENCE_THROTTLE_MS;
    expect(
      DEFAULT_RELAY_RATE_LIMITS.presenceFramesPerSecond,
    ).toBeGreaterThanOrEqual(clientPresencePerSecond);
    // The burst must at least absorb one full second at the sustained rate, or
    // a legitimate client resuming from a hiccup is refused on arrival.
    expect(
      DEFAULT_RELAY_RATE_LIMITS.presenceFramesBurst,
    ).toBeGreaterThanOrEqual(DEFAULT_RELAY_RATE_LIMITS.presenceFramesPerSecond);
  });

  it("keeps the scene frame budget at 2x the fastest legitimate flush cadence", () => {
    // Flushes are display-paced with a timer backstop for throttled tabs, so
    // the fastest legitimate cadence is whichever of the two fires more often.
    const fastestFlushHz = Math.max(
      MAX_EXPECTED_DISPLAY_REFRESH_HZ,
      1_000 / SCENE_FLUSH_BACKSTOP_MS,
    );
    expect(DEFAULT_RELAY_RATE_LIMITS.sceneFramesPerSecond).toBe(
      2 * fastestFlushHz,
    );
    expect(DEFAULT_RELAY_RATE_LIMITS.sceneFramesBurst).toBeGreaterThanOrEqual(
      DEFAULT_RELAY_RATE_LIMITS.sceneFramesPerSecond,
    );
  });
});
