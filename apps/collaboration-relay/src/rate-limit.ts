import {
  createTokenBucket,
  type TokenBucket,
} from "@drawstuff/collaboration/rate-limit";

/**
 * Relay-process rate limiting.
 *
 * The per-connection budgets (token buckets, the approved default limits, and
 * the connection limiter) live in `@drawstuff/collaboration/rate-limit`, shared
 * with the Durable Object room runtime so the two backends enforce identical
 * budgets. What stays here is the one limiter that is a *process* concern
 * rather than a connection concern: the join-attempt budget keyed by subject.
 */

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
