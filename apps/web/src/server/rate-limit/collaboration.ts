import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { TRPCError } from "@trpc/server";

import { env } from "@/env";
import {
  readRateLimitMetadata,
  type CollaborationRateLimitMetadata,
} from "@/lib/collab/rate-limit";

/**
 * Shared rate limits for the collaboration backend.
 *
 * `apps/web` runs on serverless functions, so a process-local counter is not a
 * limit at all — it is one limit per warm instance, and the instance count is
 * whatever the platform decides. Every decision here is therefore taken in
 * Upstash Redis through the official SDKs, which own the key layout, the
 * expiry and the sliding-window arithmetic. Nothing in this file writes a Redis
 * command or a Lua script.
 *
 * ## What this is, and what it is not
 *
 * A rate limit is capacity and abuse protection, not an authorization boundary.
 * That single sentence decides the failure mode: when Redis times out or
 * throws, the request is **allowed through** as `degraded` and the caller
 * continues into the checks that *are* boundaries — authentication, room role,
 * payload and batch bounds, the 512-assets-per-generation cap, and the
 * transactional invariants. Those stay fail-closed while this is degraded, so
 * Upstash cannot become the single point of failure for collaborating at all.
 *
 * `degraded` is deliberately not `allowed`: the two are the same for control
 * flow but different for observability and for the client, which must never see
 * a 429 it did not earn.
 *
 * ## Why there is no retry and no local fallback
 *
 * Each limiter decision calls Redis exactly once. An ordinary request takes one
 * decision; a leave snapshot whose normal room budget explicitly refuses may
 * take a second decision against its bounded finalization reserve. Neither is
 * retried. Retrying a decision that is already 750 ms late would multiply
 * latency during precisely the incident the timeout exists to survive, and a
 * process-local counter substituted mid-outage would look global while actually
 * being one independent limit per instance — a limit that reports numbers
 * nobody can act on.
 */

/** Version/ownership boundary. Bump `v1` rather than reusing keys on a change. */
export const COLLABORATION_RATE_LIMIT_KEY_PREFIX =
  "drawstuff:collab:ratelimit:v1";

/**
 * Redis is given 750 ms, not the SDK's 5 s default. The budget comes from the
 * caller's side: a join or a snapshot write that waits five seconds for a
 * limiter has already failed the user, so the limiter gives up long before the
 * request does.
 */
export const COLLABORATION_RATE_LIMIT_TIMEOUT_MS = 750;

export type RateLimitBudget = { tokens: number; window: `${number} s` };

export type CollaborationRateLimitOperation =
  | "join"
  | "snapshot-put"
  | "snapshot-finalize"
  | "asset-upload"
  | "asset-resolve";

/**
 * The approved values, straight from SLO §5. Windows are one minute because
 * every number in that table is stated per minute; sliding rather than fixed so
 * a caller cannot push two full windows' worth of traffic through a boundary.
 */
export const COLLABORATION_RATE_LIMITS = {
  join: { tokens: 20, window: "60 s" },
  "snapshot-put": { tokens: 6, window: "60 s" },
  // Escape hatch for the last durable write when the shared room budget is
  // already spent. The identifier is (room, user), so a client calling every
  // write "leave" only buys two bounded requests, not an unlimited bypass.
  "snapshot-finalize": { tokens: 2, window: "60 s" },
  "asset-upload": { tokens: 60, window: "60 s" },
  "asset-resolve": { tokens: 120, window: "60 s" },
} as const satisfies Record<CollaborationRateLimitOperation, RateLimitBudget>;

export type CollaborationRateLimitDecision =
  | { status: "allowed" }
  | ({ status: "limited" } & CollaborationRateLimitMetadata)
  /** Redis was unreachable, slow or broken. Fail open; not a rate limit. */
  | { status: "degraded" };

/**
 * The single shared client for the whole server bundle.
 *
 * Module scope on purpose: a client per request would rebuild the REST client
 * on every invocation, and — with `ephemeralCache` off — the only state worth
 * sharing lives in Redis anyway. `fromEnv()` reads the same two variables the
 * server schema validates, and the reference below is what makes that
 * validation the thing that fails first on a misconfigured deployment.
 */
export function createSharedRedis(): Redis {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    // Unreachable once env validation runs; kept so a build that skips
    // validation still fails loudly instead of silently never limiting.
    throw new Error("Upstash Redis credentials are not configured.");
  }
  return Redis.fromEnv({
    /**
     * This is where "no request-path retry" is actually enforced. The rest of
     * this module makes exactly one `limit()` call, but that is a layer above
     * the transport, and @upstash/redis 1.38.2 defaults to `retries: 5` with a
     * `Math.exp(n) * 50` backoff. Its request loop runs `i <= attempts`, so the
     * default turns one check into **six** POSTs spread over ~4.3 s of sleeping,
     * and the limiter's 750 ms timeout cannot stop them: it is a `Promise.race`
     * against a timer, and no `AbortSignal` reaches the requester.
     *
     * That is not merely slow. The loop retries whenever `fetch` *throws*, and a
     * throw does not prove the server did not run the script — a reset after the
     * command was processed retries a completed `INCRBY`. `EVALSHA` over a
     * counter is not idempotent, so one flaky check could consume up to six
     * tokens: enough, at 6 writes/minute, for a single network blip to spend a
     * room's whole snapshot budget by itself.
     *
     * `retries: 0` and not `retry: false`: the boolean form takes a different
     * branch that sets `attempts: 1`, which the `i <= attempts` bound turns into
     * two requests.
     */
    retry: { retries: 0 },
  });
}

const redis = createSharedRedis();

/**
 * Builds one Upstash sliding-window limiter under `prefix`. Every limiter
 * table in this app (collaboration, shared-scene) goes through here so the
 * timeout and cache policy are decided exactly once.
 */
export function createRateLimiter(
  client: Redis,
  prefix: string,
  budget: RateLimitBudget,
): Ratelimit {
  return new Ratelimit({
    redis: client,
    limiter: Ratelimit.slidingWindow(budget.tokens, budget.window),
    prefix,
    timeout: COLLABORATION_RATE_LIMIT_TIMEOUT_MS,
    // Off, and that is the whole point of this module. An in-process cache
    // would answer from whichever serverless instance happened to be warm,
    // which is the process-local counter this design exists to avoid — dressed
    // up as a cross-invocation limit.
    ephemeralCache: false,
    analytics: false,
  });
}

/**
 * Builds one named limiter. Exported so the configuration itself is testable
 * without reaching into module state.
 */
export function createCollaborationRateLimiter(
  client: Redis,
  operation: CollaborationRateLimitOperation,
): Ratelimit {
  return createRateLimiter(
    client,
    `${COLLABORATION_RATE_LIMIT_KEY_PREFIX}:${operation}`,
    COLLABORATION_RATE_LIMITS[operation],
  );
}

const limiters: Record<CollaborationRateLimitOperation, Ratelimit> = {
  join: createCollaborationRateLimiter(redis, "join"),
  "snapshot-put": createCollaborationRateLimiter(redis, "snapshot-put"),
  "snapshot-finalize": createCollaborationRateLimiter(
    redis,
    "snapshot-finalize",
  ),
  "asset-upload": createCollaborationRateLimiter(redis, "asset-upload"),
  "asset-resolve": createCollaborationRateLimiter(redis, "asset-resolve"),
};

/** The one `Ratelimit` method this module uses; lets tests supply a double. */
export type CollaborationRateLimiter = {
  limit(identifier: string): Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
    reason?: string;
  }>;
};

/**
 * Structured degradation event.
 *
 * Aggregatable by design: the payload is a fixed event name plus two closed
 * enums, so a dashboard can count `collab.ratelimit.degraded` by operation and
 * cause without anybody grepping individual lines. It carries no identifier, no
 * token, no URL and no error payload — a degradation is a fact about the
 * limiter, and the only thing an operator needs from it is "how often, where,
 * and which failure mode".
 */
function reportDegradation(
  operation: string,
  cause: "timeout" | "exception",
): void {
  console.warn(
    JSON.stringify({
      event: "collab.ratelimit.degraded",
      operation,
      cause,
    }),
  );
}

/**
 * Turns one limiter response into the typed contract.
 *
 * The SDK reports its own timeout as `success: true` with `reason: "timeout"` —
 * its built-in fail-open. That is the right behaviour and the wrong label:
 * reported as `allowed` it would be indistinguishable from a real decision, and
 * an outage would look like healthy traffic. It is separated out here, which is
 * the only reason `degraded` exists as a third state.
 */
export async function evaluateCollaborationRateLimit(
  limiter: CollaborationRateLimiter,
  // Open string on purpose: other backends (shared-scene) reuse this decision
  // pipeline with their own operation names; the closed collaboration enum
  // stays the contract for this module's own limiter table.
  operation: string,
  identifier: string,
  now: () => number = Date.now,
): Promise<CollaborationRateLimitDecision> {
  let response: Awaited<ReturnType<CollaborationRateLimiter["limit"]>>;
  try {
    // Exactly one call for this decision. Callers may compose independently
    // bounded decisions, but this layer never retries one or adds a fallback.
    response = await limiter.limit(identifier);
  } catch {
    // The error object is not logged: an Upstash SDK error message can carry
    // the request URL, which embeds the REST endpoint, and there is nothing in
    // it an aggregate cannot say better.
    reportDegradation(operation, "exception");
    return { status: "degraded" };
  }
  if (response.reason === "timeout") {
    reportDegradation(operation, "timeout");
    return { status: "degraded" };
  }
  if (response.success) return { status: "allowed" };
  return {
    status: "limited",
    reset: response.reset,
    retryAfterMs: Math.max(0, response.reset - now()),
  };
}

/**
 * Spends one token of `operation`'s budget for `identifier`.
 *
 * `identifier` must be a canonical server-side value — the authenticated user
 * id, or a room id the caller has already been shown to have access to. A
 * client-supplied identifier would let a caller choose whose budget to spend.
 */
export function checkCollaborationRateLimit(input: {
  operation: CollaborationRateLimitOperation;
  identifier: string;
}): Promise<CollaborationRateLimitDecision> {
  return evaluateCollaborationRateLimit(
    limiters[input.operation],
    input.operation,
    input.identifier,
  );
}

/**
 * Carries the retry deadline from the limiter to the tRPC error formatter.
 *
 * A `TRPCError` has no structured payload of its own, so the metadata rides on
 * the `cause` and is lifted into `data.rateLimit` in `errorFormatter`. That is
 * what makes the deadline machine-readable on the client instead of something
 * parsed out of a message.
 */
class CollaborationRateLimitedError extends Error {
  constructor(readonly rateLimit: CollaborationRateLimitMetadata) {
    super("Collaboration rate limit exceeded.");
    this.name = "CollaborationRateLimitedError";
  }
}

/** Reads the metadata back off an error's cause; used by the error formatter. */
export function rateLimitMetadataOf(
  cause: unknown,
): CollaborationRateLimitMetadata | null {
  if (!(cause instanceof CollaborationRateLimitedError)) return null;
  return readRateLimitMetadata(cause.rateLimit);
}

/**
 * Mirrors the rate-limit deadline into the HTTP transport.
 *
 * `data.rateLimit` is the contract this app's clients read; `Retry-After` is
 * the one every intermediary understands, so it is set whenever the transport
 * can express it. tRPC batches calls into a single response, so the longest
 * deadline in the batch wins — a shorter wait than one of the refusals asked
 * for would be wrong, a longer one is merely conservative.
 */
export function collaborationRateLimitResponseMeta(opts: {
  errors: readonly { cause?: unknown }[];
}): { headers?: Record<string, string> } {
  const retryAfterMs = opts.errors
    .map((error) => rateLimitMetadataOf(error.cause)?.retryAfterMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => b - a)[0];
  if (retryAfterMs === undefined) return {};
  // Seconds, rounded up: rounding down would authorize a retry the window has
  // not reset for.
  return { headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } };
}

/**
 * Rate-limits a tRPC procedure, or lets it through.
 *
 * `TOO_MANY_REQUESTS` (HTTP 429) is the only code used for a real refusal —
 * never a bare `Error`, `FORBIDDEN` or `503`, each of which a client correctly
 * treats as something other than "come back later". A `degraded` decision
 * returns normally: the procedure continues into its own guards, which is the
 * fail-open behaviour, and the caller is told nothing.
 */
export async function enforceCollaborationRateLimit(input: {
  operation: CollaborationRateLimitOperation;
  identifier: string;
}): Promise<void> {
  const decision = await checkCollaborationRateLimit(input);
  enforceCollaborationRateLimitDecision(decision);
}

/**
 * Throws the standard 429 for an already-taken decision.
 *
 * Most callers use `enforceCollaborationRateLimit`. Snapshot finalization is
 * the exception: it must inspect a refusal from the normal room budget before
 * deciding whether to spend its tiny leave-only reserve, without accidentally
 * checking either limiter twice.
 */
export function enforceCollaborationRateLimitDecision(
  decision: CollaborationRateLimitDecision,
): void {
  if (decision.status !== "limited") return;
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: "Too many collaboration requests. Please retry shortly.",
    cause: new CollaborationRateLimitedError({
      reset: decision.reset,
      retryAfterMs: decision.retryAfterMs,
    }),
  });
}
