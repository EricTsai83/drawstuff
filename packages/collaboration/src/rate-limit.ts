/**
 * Token buckets for the per-connection send-rate budgets.
 *
 * Every realtime backend bounds untrusted input by *size*: control frames,
 * data frames, connection counts, outbound buffers. What sizes alone do not
 * bound is *rate* — a joined editor could send maximum-size frames as fast as
 * it could produce them, and a single member was enough to saturate a room's
 * fanout and every peer's inbound queue (threat model T6).
 *
 * A token bucket rather than a fixed window, because the traffic it has to admit
 * is bursty by construction: the client coalesces edits per animation frame, so a
 * legitimate flush pattern is a short burst followed by silence. A fixed window
 * either rejects the burst or has to be sized for it, and sizing it for the burst
 * makes the sustained limit meaningless.
 *
 * Budgets are per connection, so a bucket lives and dies with its socket and
 * needs no eviction. This module is shared by the Node relay and the Durable
 * Object room runtime so both enforce the *same approved budgets* — a budget
 * change lands in one place and both backends' contract tests see it.
 */

/**
 * Elapsed-time source for every budget in this module.
 *
 * Deliberately *not* `Date.now`. These budgets are statements about elapsed time,
 * and wall time is not: an NTP correction or a manual clock change would hand out
 * (or withhold) refill that no time actually produced. `performance.now()` is
 * monotonic, which is the property a rate budget needs. Wall time stays where it
 * belongs — token expiry and room expiry, which are statements about *absolute*
 * time and have to survive a process restart.
 *
 * The Durable Object room runtime is the one caller that must NOT use this
 * default: hibernation tears the process down between events, so process-local
 * elapsed time is meaningless there. It injects event-arrival epoch time
 * instead, and the bucket's high-water mark absorbs wall-clock jumps.
 */
export const monotonicNow = (): number => performance.now();

export type TokenBucketOptions = {
  /** Sustained rate, in tokens per second. */
  ratePerSecond: number;
  /** Bucket size, i.e. the largest burst admitted from a full bucket. */
  burst: number;
  /** Monotonic elapsed-time source; defaults to {@link monotonicNow}. */
  now?: () => number;
};

export type TokenBucket = {
  /**
   * Charges `cost` tokens. Returns false when the bucket cannot cover it, in
   * which case nothing is deducted — a refused charge must not also drain the
   * budget the next legitimate frame needs.
   */
  tryConsume(cost?: number): boolean;
};

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { ratePerSecond, burst, now = monotonicNow } = options;
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error(
      `ratePerSecond must be a positive finite number, received ${ratePerSecond}`,
    );
  }
  if (!Number.isFinite(burst) || burst <= 0) {
    throw new Error(
      `burst must be a positive finite number, received ${burst}`,
    );
  }

  let tokens = burst;
  let lastRefillAt = now();

  return {
    tryConsume(cost = 1) {
      const currentNow = now();
      // Lazy refill: no timer per bucket, so a connection that goes quiet costs
      // nothing.
      //
      // The mark only ever moves forward. Clamping the *elapsed* value alone is
      // not enough for a clock that goes backwards and then returns: lowering the
      // mark would make the return register as freshly elapsed time, so a
      // correction of five seconds would hand out five seconds of refill at once.
      // A high-water mark makes a backward excursion cost nothing in either
      // direction, and it holds even when the injected clock is not monotonic —
      // which is exactly the property the Durable Object runtime relies on when
      // it feeds event-arrival wall time into these buckets.
      const elapsedMs = Math.max(0, currentNow - lastRefillAt);
      lastRefillAt = Math.max(lastRefillAt, currentNow);
      tokens = Math.min(burst, tokens + (elapsedMs / 1_000) * ratePerSecond);
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
  };
}

/**
 * Per-connection send budgets, as approved in
 * `docs/performance/collaboration-slo-capacity.md` §5.
 */
export type RelayRateLimits = {
  /** Scene frames per second, and the burst admitted from idle. */
  sceneFramesPerSecond: number;
  sceneFramesBurst: number;
  /**
   * Scene bytes per second, charged on the wire size of the frame. Frame count
   * alone is not a bound: 30 frames of 1 MiB is 30 MiB/s.
   */
  sceneBytesPerSecond: number;
  sceneBytesBurst: number;
  /** Presence frames per second, and the burst admitted from idle. */
  presenceFramesPerSecond: number;
  presenceFramesBurst: number;
};

export const DEFAULT_RELAY_RATE_LIMITS: RelayRateLimits = {
  /*
   * Paced by the client's display refresh rate, not by a fixed interval.
   *
   * `defaultScheduleSceneFlush` races `requestAnimationFrame` against a
   * `SCENE_FLUSH_BACKSTOP_MS` timer and takes whichever fires first, so the
   * timer is a *backstop* for a throttled tab — not a minimum interval. A
   * continuous drag on a 60 Hz display therefore sustains ~60 frames/s, and
   * `MAX_EXPECTED_DISPLAY_REFRESH_HZ`/s on the fastest display the budgets
   * plan for; upstream is paced the same way (its `syncElements` broadcasts
   * per change with no throttle). 240/s is 2x that fastest legitimate cadence.
   * The pacing constants live in `./client-pacing.ts`, and
   * `tests/rate-limit.test.ts` pins these budgets to them: a client pacing
   * change fails that contract test instead of silently invalidating budgets.
   *
   * The frame count is not the resource bound — the byte budget below is. What
   * this stops is a pathological flood of tiny frames, each of which still costs
   * one fanout iteration across up to 32 members.
   */
  sceneFramesPerSecond: 240,
  sceneFramesBurst: 480,
  /*
   * The actual resource bound: bytes routed, which is what costs socket writes
   * across up to 32 members.
   *
   * The burst has to cover the largest *legitimate* spike, and that is not an
   * edit — it is the newcomer handshake. Membership arrives one event per peer, so
   * N members joining an active room in quick succession make the elected
   * responder broadcast N full scenes (`handleRoomPeersChange` →
   * `sendFullScene`). Those broadcasts are largely redundant, since a `scene-init`
   * reaches the whole room rather than the peer that triggered it, but collapsing
   * them changes the join handshake's timing and belongs in its own change; until
   * then the burst has to absorb them. Eight maximum-size scenes does that for a
   * realistic join storm without letting the sustained rate drift.
   *
   * A normal delta is ~0.5 KB, four orders of magnitude below the sustained rate.
   */
  sceneBytesPerSecond: 2 * 1_048_576,
  sceneBytesBurst: 8 * 1_048_576,
  // Client presence is throttled to one sample per `PRESENCE_THROTTLE_MS`
  // (33 ms ≈ 30/s); pinned by the same contract test as the scene budgets.
  presenceFramesPerSecond: 40,
  presenceFramesBurst: 80,
};

export type ConnectionRateLimiter = {
  /**
   * Charges one frame of `byteLength` on `channel`. False means the connection
   * exceeded its budget and must be closed — never silently dropped: dropping a
   * scene frame creates a convergence gap the sender cannot detect, while a close
   * is repaired by the client's existing recovery path.
   */
  admitFrame(channel: "scene" | "presence", byteLength: number): boolean;
};

export function createConnectionRateLimiter(options: {
  limits: RelayRateLimits;
  now?: () => number;
}): ConnectionRateLimiter {
  const { limits, now } = options;
  const sceneFrames = createTokenBucket({
    ratePerSecond: limits.sceneFramesPerSecond,
    burst: limits.sceneFramesBurst,
    now,
  });
  const sceneBytes = createTokenBucket({
    ratePerSecond: limits.sceneBytesPerSecond,
    burst: limits.sceneBytesBurst,
    now,
  });
  const presenceFrames = createTokenBucket({
    ratePerSecond: limits.presenceFramesPerSecond,
    burst: limits.presenceFramesBurst,
    now,
  });

  return {
    admitFrame(channel, byteLength) {
      if (channel === "presence") return presenceFrames.tryConsume();
      // Both budgets must admit the frame, and the count is charged first so a
      // flood of tiny frames is refused before it can exhaust the byte bucket.
      if (!sceneFrames.tryConsume()) return false;
      return sceneBytes.tryConsume(byteLength);
    },
  };
}

/**
 * Longest time any default bucket needs to refill completely from empty, in
 * milliseconds. The Durable Object room runtime rebuilds its per-connection
 * buckets as *full* after hibernation or eviction, and that reconstruction is
 * only behaviorally equivalent to persistence if hibernation itself implies
 * the buckets would have refilled anyway: workerd requires roughly ten seconds
 * without events before it hibernates an Object, so every full-refill time
 * must stay at or below that threshold. Pinned by a contract test.
 */
export function maxFullRefillMs(limits: RelayRateLimits): number {
  return Math.max(
    (limits.sceneFramesBurst / limits.sceneFramesPerSecond) * 1_000,
    (limits.sceneBytesBurst / limits.sceneBytesPerSecond) * 1_000,
    (limits.presenceFramesBurst / limits.presenceFramesPerSecond) * 1_000,
  );
}
