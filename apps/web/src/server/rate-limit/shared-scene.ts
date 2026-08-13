import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";

import {
  COLLABORATION_RATE_LIMIT_TIMEOUT_MS,
  createSharedRedis,
  evaluateCollaborationRateLimit,
  type CollaborationRateLimitDecision,
} from "./collaboration";

/**
 * Rate limits for the shared-scene (share-link) backend, reusing the
 * collaboration module's decision pipeline: Upstash-backed sliding windows,
 * one Redis call per decision, no retry, and fail-open `degraded` when Redis
 * is slow or down — a rate limit is capacity protection, not an authorization
 * boundary.
 *
 * Why these exist (plan 03, M12/L3): creating a shared scene writes up to
 * 5 MiB of `bytea` per call behind nothing but a login session, and the two
 * public read procedures could be hammered anonymously. Creation is limited
 * per authenticated user; public reads are limited per client IP.
 */

/** Version/ownership boundary, disjoint from the collaboration namespace. */
export const SHARED_SCENE_RATE_LIMIT_KEY_PREFIX =
  "drawstuff:shared-scene:ratelimit:v1";

export type SharedSceneRateLimitOperation = "create" | "read";

export const SHARED_SCENE_RATE_LIMITS = {
  /** Per user. Each call may persist a multi-MiB row that lives 30 days. */
  create: { tokens: 10, window: "60 s" },
  /** Per client IP, covering both public read procedures together. */
  read: { tokens: 120, window: "60 s" },
} as const satisfies Record<
  SharedSceneRateLimitOperation,
  { tokens: number; window: `${number} s` }
>;

export function createSharedSceneRateLimiter(
  client: Redis,
  operation: SharedSceneRateLimitOperation,
): Ratelimit {
  const { tokens, window } = SHARED_SCENE_RATE_LIMITS[operation];
  return new Ratelimit({
    redis: client,
    limiter: Ratelimit.slidingWindow(tokens, window),
    prefix: `${SHARED_SCENE_RATE_LIMIT_KEY_PREFIX}:${operation}`,
    timeout: COLLABORATION_RATE_LIMIT_TIMEOUT_MS,
    ephemeralCache: false,
    analytics: false,
  });
}

/**
 * Lazy singleton: built on the first decision, not at import time. The router
 * graph pulls this module into every tRPC caller, and tests that stub the
 * collaboration module would otherwise pay for a Redis client they never use.
 */
let limiters: Record<SharedSceneRateLimitOperation, Ratelimit> | null = null;

function limiterFor(operation: SharedSceneRateLimitOperation): Ratelimit {
  if (!limiters) {
    const redis = createSharedRedis();
    limiters = {
      create: createSharedSceneRateLimiter(redis, "create"),
      read: createSharedSceneRateLimiter(redis, "read"),
    };
  }
  return limiters[operation];
}

/**
 * Spends one token of `operation`'s budget for `identifier`. The identifier
 * must be a canonical server-side value: the authenticated user id for
 * `create`, the transport-reported client IP for `read`.
 */
export function checkSharedSceneRateLimit(input: {
  operation: SharedSceneRateLimitOperation;
  identifier: string;
}): Promise<CollaborationRateLimitDecision> {
  return evaluateCollaborationRateLimit(
    limiterFor(input.operation),
    `shared-scene-${input.operation}`,
    input.identifier,
  );
}

/**
 * The client IP a Vercel/proxy deployment reports, for the public-read
 * limiter. `null` (local dev, direct invocation) skips limiting rather than
 * funnelling every unidentified caller into one shared bucket.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = headers.get("x-real-ip")?.trim();
  return realIp ? realIp : null;
}
