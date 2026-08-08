/**
 * Token buckets for the relay's send-rate budgets.
 *
 * The relay already bounds every untrusted input by *size*: control frames,
 * data frames, control bodies, connection counts, outbound buffers. What it did
 * not bound was *rate* — a joined editor could send maximum-size frames as fast
 * as it could produce them, and a single member was enough to saturate a room's
 * fanout and every peer's inbound queue. Sizes were bounded and rates were not,
 * which is the gap recorded as T6 in the threat model.
 *
 * A token bucket rather than a fixed window, because the traffic it has to admit
 * is bursty by construction: the client coalesces edits per animation frame, so a
 * legitimate flush pattern is a short burst followed by silence. A fixed window
 * either rejects the burst or has to be sized for it, and sizing it for the burst
 * makes the sustained limit meaningless.
 *
 * Budgets are per connection, so a bucket lives and dies with its socket and
 * needs no eviction. The one exception is `createSubjectRateLimiter`, which is
 * keyed by *subject* precisely because it has to survive the connection — see
 * its own note on why that one is bounded explicitly.
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
      // direction, and it holds even when the injected clock is not monotonic.
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
   * `defaultScheduleSceneFlush` races `requestAnimationFrame` against a 32 ms
   * timer and takes whichever fires first, so the timer is a *backstop* for a
   * throttled tab — not a minimum interval. A continuous drag on a 60 Hz display
   * therefore sustains ~60 frames/s, and ~120/s on a 120 Hz display; upstream is
   * paced the same way (its `syncElements` broadcasts per change with no
   * throttle). 240/s is 2x the fastest legitimate cadence.
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
  // Client presence is throttled to one sample per 33 ms ≈ 30/s.
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
 * Join-attempt budget keyed by authenticated subject.
 *
 * Unlike the per-connection buckets this one must outlive the socket — that is
 * the whole point: `maxConnections` bounds how many connections exist at once,
 * not how fast one subject may churn through them, and connect/disconnect churn
 * costs a token verification and a fanout mutation every time.
 *
 * Keyed state that outlives connections has to be bounded explicitly, or it is
 * itself the resource-exhaustion vector (repo rule 5: no unbounded caches). Two
 * mechanisms do that: an idle entry is dropped once its bucket has refilled to
 * full (at which point it carries no information), and the map has a hard entry
 * cap. On reaching the cap the limiter **admits** rather than rejects — refusing
 * would let one attacker's key churn lock out every legitimate subject, which
 * turns a rate limiter into the outage it exists to prevent.
 */
export type SubjectRateLimiter = {
  admitJoin(subject: string): boolean;
  /** Live entry count for tests and relay metrics. */
  size(): number;
  /**
   * Entry cap this limiter fails open at. Exposed so `/metrics` publishes the
   * limiter's own bound rather than a module default that an injected limiter
   * may not share.
   */
  readonly maxTrackedSubjects: number;
};

/**
 * Join attempts per subject per minute. Recovery's own budget is 10 attempts
 * with a 30 s backoff ceiling, so a well-behaved client never reaches this in a
 * minute.
 */
const DEFAULT_JOIN_ATTEMPTS_PER_MINUTE = 10;

/**
 * Entry cap for the subject map. Sized above `maxConnections` so a full relay's
 * worth of distinct subjects always fits; the cap only engages under deliberate
 * key churn.
 */
export const DEFAULT_MAX_TRACKED_SUBJECTS = 1_024;

export function createSubjectRateLimiter(options?: {
  attemptsPerMinute?: number;
  burst?: number;
  maxTrackedSubjects?: number;
  now?: () => number;
}): SubjectRateLimiter {
  const attemptsPerMinute =
    options?.attemptsPerMinute ?? DEFAULT_JOIN_ATTEMPTS_PER_MINUTE;
  const burst = options?.burst ?? attemptsPerMinute;
  const maxTrackedSubjects =
    options?.maxTrackedSubjects ?? DEFAULT_MAX_TRACKED_SUBJECTS;
  const now = options?.now ?? Date.now;
  const ratePerSecond = attemptsPerMinute / 60;
  /** Milliseconds for an empty bucket to refill completely. */
  const fullRefillMs = (burst / ratePerSecond) * 1_000;

  type Entry = { bucket: TokenBucket; lastSeenAt: number };
  const entries = new Map<string, Entry>();

  /** Drops entries whose buckets have had time to refill; they hold no state. */
  const evictRefilled = (currentNow: number): void => {
    for (const [subject, entry] of entries) {
      if (currentNow - entry.lastSeenAt >= fullRefillMs)
        entries.delete(subject);
    }
  };

  return {
    admitJoin(subject) {
      const currentNow = now();
      let entry = entries.get(subject);
      if (!entry) {
        evictRefilled(currentNow);
        if (entries.size >= maxTrackedSubjects) {
          // Fail open, deliberately: see the note on this type.
          return true;
        }
        entry = {
          bucket: createTokenBucket({ ratePerSecond, burst, now }),
          lastSeenAt: currentNow,
        };
        entries.set(subject, entry);
      }
      entry.lastSeenAt = currentNow;
      return entry.bucket.tryConsume();
    },
    size: () => entries.size,
    maxTrackedSubjects,
  };
}
