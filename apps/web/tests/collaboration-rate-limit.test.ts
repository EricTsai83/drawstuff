// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";

import {
  COLLABORATION_RATE_LIMITS,
  COLLABORATION_RATE_LIMIT_KEY_PREFIX,
  COLLABORATION_RATE_LIMIT_TIMEOUT_MS,
  createCollaborationRateLimiter,
  createSharedRedis,
  evaluateCollaborationRateLimit,
  type CollaborationRateLimiter,
  type CollaborationRateLimitOperation,
} from "@/server/rate-limit/collaboration";

/**
 * The shared-limiter contract.
 *
 * Two separate things are established here and they need different tools.
 *
 * The **configuration** — key prefix, algorithm, window, timeout, and the
 * absence of an ephemeral cache — is asserted against the real `Ratelimit`
 * objects this module builds, because every one of those is a decision the SLO
 * or the threat model made and none of them is observable from behaviour alone.
 *
 * The **decision contract** — allowed / limited / degraded, what a timeout
 * means, what an exception means, and that neither is retried — is asserted
 * against a double, because the point of the contract is what this module does
 * with a response, and a real Redis would make every one of those cases either
 * slow or unreproducible. The counting semantics are exercised against a shared
 * in-memory window that models what Redis is *for*: two independently
 * constructed limiters, standing in for two serverless invocations, reading and
 * writing one authoritative counter.
 */

/** Reaches the protected configuration a `Ratelimit` records at construction. */
type LimiterInternals = {
  prefix: string;
  timeout: number;
  ctx: { cache?: unknown };
};

const internalsOf = (limiter: Ratelimit): LimiterInternals =>
  limiter as unknown as LimiterInternals;

/** Constructing an Upstash REST client opens no connection. */
const fakeRedis = {} as Redis;

const OPERATIONS: CollaborationRateLimitOperation[] = [
  "join",
  "snapshot-put",
  "snapshot-finalize",
  "asset-upload",
  "asset-resolve",
];

const limiterDouble = (
  responses: Awaited<ReturnType<CollaborationRateLimiter["limit"]>>[],
): CollaborationRateLimiter & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    limit(identifier) {
      calls.push(identifier);
      const next = responses[calls.length - 1];
      if (!next) throw new Error("limiter called more times than scripted");
      return Promise.resolve(next);
    },
  };
};

const allowedResponse = {
  success: true,
  limit: 20,
  remaining: 19,
  reset: 60_000,
};

describe("collaboration rate limit configuration", () => {
  it("matches the approved SLO §5 values", () => {
    // These four numbers are the contract with
    // docs/performance/collaboration-slo-capacity.md §5. Changing one here
    // without changing it there is the failure this asserts against.
    expect(COLLABORATION_RATE_LIMITS).toEqual({
      join: { tokens: 20, window: "60 s" },
      "snapshot-put": { tokens: 6, window: "60 s" },
      "snapshot-finalize": { tokens: 2, window: "60 s" },
      "asset-upload": { tokens: 60, window: "60 s" },
      "asset-resolve": { tokens: 120, window: "60 s" },
    });
  });

  it("owns exactly the versioned key namespace, one suffix per operation", () => {
    expect(COLLABORATION_RATE_LIMIT_KEY_PREFIX).toBe(
      "drawstuff:collab:ratelimit:v1",
    );
    const prefixes = OPERATIONS.map(
      (operation) =>
        internalsOf(createCollaborationRateLimiter(fakeRedis, operation))
          .prefix,
    );
    expect(prefixes).toEqual([
      "drawstuff:collab:ratelimit:v1:join",
      "drawstuff:collab:ratelimit:v1:snapshot-put",
      "drawstuff:collab:ratelimit:v1:snapshot-finalize",
      "drawstuff:collab:ratelimit:v1:asset-upload",
      "drawstuff:collab:ratelimit:v1:asset-resolve",
    ]);
    // `v1` is an ownership boundary: a change in algorithm or semantics takes a
    // new version rather than reusing keys written under the old meaning.
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("gives Redis 750 ms, not the SDK's five-second default", () => {
    expect(COLLABORATION_RATE_LIMIT_TIMEOUT_MS).toBe(750);
    for (const operation of OPERATIONS) {
      expect(
        internalsOf(createCollaborationRateLimiter(fakeRedis, operation))
          .timeout,
      ).toBe(750);
    }
  });

  it("keeps no ephemeral cache, so no decision comes from a warm instance", () => {
    // Left undefined, the SDK installs a process-local `Map`. That is the
    // serverless-local counter this whole module exists to avoid: it would
    // answer from whichever instance happened to be warm while presenting
    // itself as a shared limit.
    for (const operation of OPERATIONS) {
      expect(
        internalsOf(createCollaborationRateLimiter(fakeRedis, operation)).ctx
          .cache,
      ).toBeUndefined();
    }
  });

  it("uses a sliding window with each operation's approved size", () => {
    const slidingWindow = vi.spyOn(Ratelimit, "slidingWindow");
    try {
      for (const operation of OPERATIONS) {
        createCollaborationRateLimiter(fakeRedis, operation);
      }
      // Fixed windows let a caller push two full windows' worth of traffic
      // through the boundary between them.
      expect(slidingWindow.mock.calls).toEqual([
        [20, "60 s"],
        [6, "60 s"],
        [2, "60 s"],
        [60, "60 s"],
        [120, "60 s"],
      ]);
    } finally {
      slidingWindow.mockRestore();
    }
  });
});

describe("the shared Redis client", () => {
  /** The `HttpClient` a `Redis` builds; where the retry policy actually lives. */
  const requesterOf = (client: Redis) =>
    client as unknown as { client: { retry: { attempts: number } } };

  it("disables the SDK's transport retries", () => {
    // `attempts: 0` and the SDK's `i <= attempts` loop bound mean one request.
    // The default is 5, which is six. `retry: false` would take a different
    // branch and set `attempts: 1` — two requests — so the boolean form is not
    // an equivalent spelling of this.
    expect(requesterOf(createSharedRedis()).client.retry.attempts).toBe(0);
  });

  it("issues exactly one HTTP request when the network rejects", async () => {
    // The assertion the requirement actually needs, taken at the transport.
    // Against the SDK default this fails with six calls, because the retry loop
    // fires on a thrown `fetch` — and a throw does not prove the server did not
    // already run the non-idempotent increment.
    const fetchCalls: string[] = [];
    const stub = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return Promise.reject(new Error("ECONNRESET"));
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const limiter = createCollaborationRateLimiter(
        createSharedRedis(),
        "snapshot-put",
      );
      await expect(
        evaluateCollaborationRateLimit(limiter, "snapshot-put", "room-a"),
      ).resolves.toEqual({ status: "degraded" });
      expect(fetchCalls).toHaveLength(1);
    } finally {
      stub.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("collaboration rate limit decisions", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("allows a request the shared counter has budget for", async () => {
    const limiter = limiterDouble([allowedResponse]);
    await expect(
      evaluateCollaborationRateLimit(limiter, "join", "user-a"),
    ).resolves.toEqual({ status: "allowed" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a real refusal with the reset instant and the wait", async () => {
    const limiter = limiterDouble([
      { success: false, limit: 20, remaining: 0, reset: 61_000 },
    ]);
    await expect(
      evaluateCollaborationRateLimit(limiter, "join", "user-a", () => 1_000),
    ).resolves.toEqual({
      status: "limited",
      reset: 61_000,
      retryAfterMs: 60_000,
    });
  });

  it("never reports a negative wait for a window that already reset", async () => {
    const limiter = limiterDouble([
      { success: false, limit: 20, remaining: 0, reset: 500 },
    ]);
    await expect(
      evaluateCollaborationRateLimit(limiter, "join", "user-a", () => 5_000),
    ).resolves.toEqual({ status: "limited", reset: 500, retryAfterMs: 0 });
  });

  it("fails open as degraded when the SDK times out, not as allowed", async () => {
    // The SDK's own timeout answer is `success: true`. Reported as `allowed` it
    // would be indistinguishable from a real decision and an outage would look
    // like healthy traffic — which is the entire reason `degraded` exists.
    const limiter = limiterDouble([
      { success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" },
    ]);
    await expect(
      evaluateCollaborationRateLimit(limiter, "snapshot-put", "room-a"),
    ).resolves.toEqual({ status: "degraded" });
  });

  it("fails open as degraded when the SDK throws", async () => {
    const calls: string[] = [];
    const limiter: CollaborationRateLimiter = {
      limit(identifier) {
        calls.push(identifier);
        return Promise.reject(new Error("ECONNREFUSED https://secret.upstash"));
      },
    };
    await expect(
      evaluateCollaborationRateLimit(limiter, "asset-upload", "user-a"),
    ).resolves.toEqual({ status: "degraded" });
    expect(calls).toEqual(["user-a"]);
  });

  it("invokes the limiter exactly once per check, on every path", async () => {
    // Deliberately scoped to *this* layer: it proves this module adds no retry
    // of its own. It says nothing about how many HTTP requests one `limit()`
    // becomes — the SDK's own transport decides that, and its default would
    // make six. That is asserted separately, against the real requester, in
    // "the shared Redis client" below; an earlier version of this test claimed
    // to cover it and did not.
    const allowed = limiterDouble([allowedResponse]);
    await evaluateCollaborationRateLimit(allowed, "join", "user-a");
    expect(allowed.calls).toHaveLength(1);

    const timedOut = limiterDouble([
      { success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" },
    ]);
    await evaluateCollaborationRateLimit(timedOut, "join", "user-a");
    expect(timedOut.calls).toHaveLength(1);

    const refused = limiterDouble([
      { success: false, limit: 20, remaining: 0, reset: 1 },
    ]);
    await evaluateCollaborationRateLimit(refused, "join", "user-a");
    expect(refused.calls).toHaveLength(1);
  });

  it("emits one aggregatable degradation event carrying no capability", async () => {
    const limiter: CollaborationRateLimiter = {
      limit: () => Promise.reject(new Error("https://db.upstash.io token=abc")),
    };
    await evaluateCollaborationRateLimit(
      limiter,
      "asset-resolve",
      "user-secret",
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      event: "collab.ratelimit.degraded",
      operation: "asset-resolve",
      cause: "exception",
    });
    // The same failure must aggregate rather than only being greppable, and it
    // must not carry the identifier, the endpoint or the error payload — an
    // Upstash error message embeds the REST URL and the token it was called
    // with.
    expect(line).not.toContain("user-secret");
    expect(line).not.toContain("upstash");
    expect(line).not.toContain("abc");
  });

  it("labels a timeout degradation separately from an exception", async () => {
    const limiter = limiterDouble([
      { success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" },
    ]);
    await evaluateCollaborationRateLimit(limiter, "join", "user-a");
    expect(JSON.parse((warn.mock.calls[0] as [string])[0])).toEqual({
      event: "collab.ratelimit.degraded",
      operation: "join",
      cause: "timeout",
    });
  });
});

/**
 * One authoritative sliding window, shared the way Redis is.
 *
 * Models exactly the property serverless deployment needs and a process-local
 * counter cannot have: the store outlives any one limiter object, so a limiter
 * built fresh in a cold invocation sees what a previous invocation counted.
 * Entries expire with the window, which is how `@upstash/ratelimit` keeps the
 * key space bounded and how a caller gets its budget back.
 */
function createSharedWindow(windowMs: number, tokens: number) {
  const hits = new Map<string, number[]>();
  return {
    /** Keys still holding state; a released window must leave none behind. */
    liveKeys(at: number): string[] {
      return [...hits.entries()]
        .filter(([, stamps]) => stamps.some((stamp) => stamp > at - windowMs))
        .map(([key]) => key);
    },
    /** A limiter as one serverless invocation would construct it. */
    invocation(prefix: string, now: () => number): CollaborationRateLimiter {
      return {
        limit(identifier) {
          const at = now();
          const key = `${prefix}:${identifier}`;
          const recent = (hits.get(key) ?? []).filter(
            (stamp) => stamp > at - windowMs,
          );
          const reset = (recent[0] ?? at) + windowMs;
          if (recent.length >= tokens) {
            hits.set(key, recent);
            return Promise.resolve({
              success: false,
              limit: tokens,
              remaining: 0,
              reset,
            });
          }
          recent.push(at);
          hits.set(key, recent);
          return Promise.resolve({
            success: true,
            limit: tokens,
            remaining: tokens - recent.length,
            reset,
          });
        },
      };
    },
  };
}

describe("collaboration rate limit counting semantics", () => {
  const WINDOW_MS = 60_000;

  it("counts one identifier across separate invocations of the same limiter", async () => {
    // The reason this module exists: two cold serverless invocations must share
    // one budget, not hold one each.
    const window = createSharedWindow(WINDOW_MS, 20);
    let clock = 0;
    const now = () => clock;
    const prefix = "drawstuff:collab:ratelimit:v1:join";

    for (let call = 0; call < 20; call += 1) {
      // A brand-new limiter every time, as a cold start would build.
      const invocation = window.invocation(prefix, now);
      const decision = await evaluateCollaborationRateLimit(
        invocation,
        "join",
        "user-a",
        now,
      );
      expect(decision.status).toBe("allowed");
      clock += 100;
    }

    const twentyFirst = await evaluateCollaborationRateLimit(
      window.invocation(prefix, now),
      "join",
      "user-a",
      now,
    );
    expect(twentyFirst).toEqual({
      status: "limited",
      reset: WINDOW_MS,
      retryAfterMs: WINDOW_MS - clock,
    });
  });

  it("keeps identifiers isolated, so one caller cannot spend another's budget", async () => {
    const window = createSharedWindow(WINDOW_MS, 6);
    const now = () => 0;
    const prefix = "drawstuff:collab:ratelimit:v1:snapshot-put";
    const spend = (identifier: string) =>
      evaluateCollaborationRateLimit(
        window.invocation(prefix, now),
        "snapshot-put",
        identifier,
        now,
      );

    for (let call = 0; call < 6; call += 1) {
      expect((await spend("room-a")).status).toBe("allowed");
    }
    expect((await spend("room-a")).status).toBe("limited");
    // A different room's budget is untouched by the exhausted one.
    expect((await spend("room-b")).status).toBe("allowed");
  });

  it("keeps operations isolated, so one budget cannot exhaust another", async () => {
    const window = createSharedWindow(WINDOW_MS, 6);
    const now = () => 0;
    const spendJoin = () =>
      evaluateCollaborationRateLimit(
        window.invocation("drawstuff:collab:ratelimit:v1:join", now),
        "join",
        "user-a",
        now,
      );
    const spendResolve = () =>
      evaluateCollaborationRateLimit(
        window.invocation("drawstuff:collab:ratelimit:v1:asset-resolve", now),
        "asset-resolve",
        "user-a",
        now,
      );

    for (let call = 0; call < 6; call += 1) await spendJoin();
    expect((await spendJoin()).status).toBe("limited");
    expect((await spendResolve()).status).toBe("allowed");
  });

  it("releases the count once the window has passed, leaving no live key", async () => {
    const window = createSharedWindow(WINDOW_MS, 6);
    let clock = 0;
    const now = () => clock;
    const prefix = "drawstuff:collab:ratelimit:v1:snapshot-put";
    const spend = () =>
      evaluateCollaborationRateLimit(
        window.invocation(prefix, now),
        "snapshot-put",
        "room-a",
        now,
      );

    for (let call = 0; call < 6; call += 1) await spend();
    const refused = await spend();
    expect(refused.status).toBe("limited");
    expect(window.liveKeys(clock)).toEqual([`${prefix}:room-a`]);

    // The SDK owns key expiry; nothing here writes a permanent key. Waiting out
    // the window a refusal named must be enough to get the budget back — a
    // limiter a caller can never recover from is an outage, not a limit.
    clock += WINDOW_MS + 1;
    expect((await spend()).status).toBe("allowed");
    expect(window.liveKeys(clock + WINDOW_MS + 1)).toEqual([]);
  });
});
