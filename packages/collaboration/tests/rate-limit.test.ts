import { describe, expect, it } from "vitest";

import {
  KEEPALIVE_INTERVAL_MS,
  MAX_EXPECTED_DISPLAY_REFRESH_HZ,
  PRESENCE_THROTTLE_MS,
  SCENE_FLUSH_BACKSTOP_MS,
} from "../src/client-pacing.ts";
import {
  createConnectionRateLimiter,
  createTokenBucket,
  DEFAULT_RELAY_RATE_LIMITS,
  maxFullRefillMs,
  type ConnectionRateLimiter,
} from "../src/rate-limit.ts";

/**
 * The shared rate-limit primitives (moved here from the relay in Plan 10 so
 * the Durable Object room runtime enforces the same budgets). The
 * connection-level behaviour they drive is covered by each backend's own
 * tests; what matters here is the arithmetic — including the wall-clock-jump
 * behaviour the Durable Object depends on, since it feeds event-arrival epoch
 * time rather than a monotonic clock into these buckets.
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
    // hand out a whole burst during a clock correction. This is the property
    // the Durable Object runtime leans on when it injects wall time.
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

/**
 * Hibernation contract: the Durable Object room runtime rebuilds its
 * per-connection buckets as *full* after hibernation, which is only
 * behaviorally equivalent to persisting them if every bucket would have
 * refilled during the quiet period hibernation itself requires (~10 s without
 * events in workerd). A budget change that breaks this fails here, not in
 * production admission control.
 */
describe("default budgets against the hibernation refill contract", () => {
  const WORKERD_MIN_HIBERNATION_IDLE_MS = 10_000;

  it("keeps every full-bucket refill at or below the hibernation idle threshold", () => {
    expect(maxFullRefillMs(DEFAULT_RELAY_RATE_LIMITS)).toBeLessThanOrEqual(
      WORKERD_MIN_HIBERNATION_IDLE_MS,
    );
  });

  it("keeps the keepalive cadence well inside the liveness budget it sizes", () => {
    // Two missed keepalives plus slack is the Durable Object's dead-peer
    // bound; the cadence itself must stay meaningful (an interval of zero or
    // one far beyond the relay heartbeat would silently change dead-peer
    // detection on one backend only).
    expect(KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
    expect(KEEPALIVE_INTERVAL_MS).toBe(15_000);
  });
});
