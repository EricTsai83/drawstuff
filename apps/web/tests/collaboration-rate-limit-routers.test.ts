// @vitest-environment node
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

import type { Ratelimit as UpstashRatelimit } from "@upstash/ratelimit";

vi.mock("server-only", () => ({}));

vi.mock("@/env", () => ({
  env: {
    COLLAB_IDENTITY_SECRET: "i".repeat(32),
    COLLAB_AUTHORITY_SECRET: "a".repeat(32),
    COLLAB_CONTROL_URL: "https://gateway.test",
    UPSTASH_REDIS_REST_URL: "https://redis.test",
    UPSTASH_REDIS_REST_TOKEN: "test",
  },
}));
vi.mock("@/server/collab/authority-identity", () => ({
  issueAuthorityIdentity: () =>
    Promise.reject(new TRPCError({ code: "NOT_FOUND" })),
}));
/** Room gateway is isolated from these Redis-ordering tests; its live authorization and races are covered in workerd. */
vi.mock("@/server/collab/asset-authority", () => ({
  requestAssetAuthority: async (
    _db: unknown,
    account: { subject: string },
    request: { roomId: string; fileIds: string[] },
  ) => {
    if (account.subject === "user-stranger")
      throw new TRPCError({ code: "FORBIDDEN" });
    return {
      result: {
        roomId: request.roomId,
        assets: [],
        missing: request.fileIds,
      },
    };
  },
}));

/**
 * Scripted Redis answers, one per `limit()` call.
 *
 * Only `Ratelimit#limit` is replaced, not the module under test: the real
 * limiters are built with their real prefixes and timeout, the real
 * `enforceCollaborationRateLimit` decides what to throw, and the real
 * `errorFormatter` shapes it. What is faked is exactly the one thing that would
 * otherwise need a live Redis — the answer that comes back.
 */
type ScriptedResponse =
  | { success: boolean; limit: number; remaining: number; reset: number }
  | { kind: "timeout" }
  | { kind: "throw" };

const limitCalls: { operation: string; identifier: string }[] = [];
let scripted: ScriptedResponse = {
  success: true,
  limit: 20,
  remaining: 19,
  reset: 60_000,
};

vi.mock("@upstash/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<{ Ratelimit: typeof UpstashRatelimit }>();
  class TestRatelimit extends actual.Ratelimit {
    // Assigned as an instance field, so it replaces the base class's own
    // `limit` field after `super()` has recorded the real configuration.
    limit = (identifier: string) => {
      const prefix = (this as unknown as { prefix: string }).prefix;
      limitCalls.push({
        operation: prefix.split(":").pop() ?? prefix,
        identifier,
      });
      const response = scripted;
      if ("kind" in response) {
        if (response.kind === "throw") {
          return Promise.reject(new Error("redis unreachable"));
        }
        return Promise.resolve({
          success: true,
          limit: 0,
          remaining: 0,
          reset: 0,
          pending: Promise.resolve(),
          reason: "timeout" as const,
        });
      }
      return Promise.resolve({ ...response, pending: Promise.resolve() });
    };
  }
  return { ...actual, Ratelimit: TestRatelimit };
});

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";

import { appRouter, createCaller } from "@/server/api/root";
import * as schema from "@/server/db/schema";
import { openTestDatabase } from "./support/pglite-db";
import { testTrpcContext } from "./support/trpc-caller";
import {
  collaborationRateLimitResponseMeta,
  rateLimitMetadataOf,
} from "@/server/rate-limit/collaboration";

/**
 * Where the shared limiter sits relative to everything else.
 *
 * The numbers themselves are settled in `collaboration-rate-limit.test.ts`.
 * What matters here is placement and consequence: a real refusal is a 429 with
 * a machine-readable deadline; an unauthenticated or unauthorized caller is
 * refused *before* it can spend anybody's budget; and a degraded limiter
 * changes nothing about the guards that are actually boundaries.
 */

const testDb = openTestDatabase();

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const STRANGER = "user-stranger";

const contextFor = (userId: string | null) => testTrpcContext(testDb, userId);

const callerFor = (userId: string | null) => createCaller(contextFor(userId));

const allow = (): void => {
  scripted = { success: true, limit: 20, remaining: 19, reset: 60_000 };
};
const refuse = (reset: number): void => {
  scripted = { success: false, limit: 20, remaining: 0, reset };
};

async function openRoom() {
  return { roomId: "room-rate-limit" };
}
const grant = async (
  _roomId: string,
  _subject: string,
  _role: "editor" | "viewer",
) => undefined;

const codeOf = (error: unknown): string | undefined =>
  error instanceof TRPCError ? error.code : undefined;

beforeEach(async () => {
  allow();
  limitCalls.length = 0;
  await testDb.delete(schema.collaborationSnapshot);
  await testDb.delete(schema.collaborationRoomMember);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: EDITOR, name: "Editor", email: "editor@example.com" },
    { id: VIEWER, name: "Viewer", email: "viewer@example.com" },
    { id: STRANGER, name: "Stranger", email: "stranger@example.com" },
  ]);
});

describe("rate limit ordering against authentication and authorization", () => {
  it("refuses an unauthenticated caller without spending a budget", async () => {
    // Authentication is not the limiter's job and must precede it: there is no
    // canonical identity to charge yet, and charging a guessed one would let an
    // anonymous caller drain a signed-in user's budget.
    await expect(
      callerFor(null).collaborationAuthority.identity({
        roomId: "room-anything",
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === "UNAUTHORIZED");
    expect(limitCalls).toEqual([]);
  });

  it("rejects malformed input before spending a budget", async () => {
    await expect(
      callerFor(OWNER).collaborationAsset.resolve({
        roomId: "room-a",
        fileIds: [],
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === "BAD_REQUEST");
    expect(limitCalls).toEqual([]);
  });

  it("charges join to the caller's own identity, before any room lookup", async () => {
    refuse(Date.now() + 30_000);
    // The room does not exist. A user-scoped limiter that ran after the lookup
    // would answer NOT_FOUND here and would have done a query to say so.
    await expect(
      callerFor(EDITOR).collaborationAuthority.identity({
        roomId: "room-missing",
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === "TOO_MANY_REQUESTS");
    expect(limitCalls).toEqual([{ operation: "join", identifier: EDITOR }]);
  });

  it("charges asset resolve to the caller, before any room lookup", async () => {
    refuse(Date.now() + 30_000);
    await expect(
      callerFor(EDITOR).collaborationAsset.resolve({
        roomId: "room-missing",
        fileIds: ["abcdef0123456789abcdef0123456789abcdef01"],
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === "TOO_MANY_REQUESTS");
    expect(limitCalls).toEqual([
      { operation: "asset-resolve", identifier: EDITOR },
    ]);
  });
});

describe("a real refusal", () => {
  it("is TOO_MANY_REQUESTS carrying the reset instant and the wait", async () => {
    const reset = Date.now() + 45_000;
    refuse(reset);
    const error = await callerFor(EDITOR)
      .collaborationAuthority.identity({ roomId: "room-a" })
      .catch((thrown: unknown) => thrown);

    expect(codeOf(error)).toBe("TOO_MANY_REQUESTS");
    // The deadline rides on the cause, which is what `errorFormatter` lifts
    // into `data.rateLimit` for the client.
    expect(rateLimitMetadataOf((error as TRPCError).cause)).toEqual({
      reset,
      retryAfterMs: expect.any(Number) as number,
    });
  });

  it("reaches the client as HTTP 429 with Retry-After and machine-readable data", async () => {
    const reset = Date.now() + 45_000;
    refuse(reset);
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(
        "http://localhost/api/trpc/collaborationAuthority.identity?batch=1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ 0: { json: { roomId: "room-a" } } }),
        },
      ),
      router: appRouter,
      createContext: () => Promise.resolve(contextFor(EDITOR)),
      responseMeta: collaborationRateLimitResponseMeta,
    });

    // Not a bare Error, not FORBIDDEN, not 503: each of those is read by a
    // client as something other than "come back later".
    expect(response.status).toBe(429);
    // Whole seconds, rounded up, so the header never authorizes an early retry.
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      44,
    );

    const body = (await response.json()) as [
      { error: { json: { data: { code: string; rateLimit: unknown } } } },
    ];
    expect(body[0]?.error.json.data.code).toBe("TOO_MANY_REQUESTS");
    // The deadline is a field, not a sentence: a client that had to parse the
    // message would break the first time the wording changed.
    expect(body[0]?.error.json.data.rateLimit).toMatchObject({
      reset,
      retryAfterMs: expect.any(Number) as number,
    });
  });

  it("carries no rate-limit metadata on unrelated errors", async () => {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(
        "http://localhost/api/trpc/collaborationAuthority.identity?batch=1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ 0: { json: { roomId: "room-missing" } } }),
        },
      ),
      router: appRouter,
      createContext: () => Promise.resolve(contextFor(EDITOR)),
      responseMeta: collaborationRateLimitResponseMeta,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    const body = (await response.json()) as [
      { error: { json: { data: { rateLimit: unknown } } } },
    ];
    expect(body[0]?.error.json.data.rateLimit).toBeNull();
  });
});

describe("Redis degradation", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const failureModes: [label: string, script: ScriptedResponse][] = [
    ["a timeout", { kind: "timeout" }],
    ["an exception", { kind: "throw" }],
  ];

  for (const [label, script] of failureModes) {
    describe(`on ${label}`, () => {
      beforeEach(() => {
        scripted = script;
      });

      it("lets an authorized asset lookup through instead of returning 429", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        await expect(
          callerFor(EDITOR).collaborationAsset.resolve({
            roomId: room.roomId,
            fileIds: ["abcdef0123456789abcdef0123456789abcdef01"],
          }),
        ).resolves.toMatchObject({ assets: [] });
      });

      it("still refuses an unauthenticated join", async () => {
        await expect(
          callerFor(null).collaborationAuthority.identity({ roomId: "room-a" }),
        ).rejects.toSatisfy((error) => codeOf(error) === "UNAUTHORIZED");
      });

      it("still refuses a stranger's asset lookup", async () => {
        const room = await openRoom();
        scripted = script;
        await expect(
          callerFor(STRANGER).collaborationAsset.resolve({
            roomId: room.roomId,
            fileIds: ["abcdef0123456789abcdef0123456789abcdef01"],
          }),
        ).rejects.toSatisfy((error) => codeOf(error) === "FORBIDDEN");
      });

      it("never turns a degradation into a 429", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        const outcome = await callerFor(EDITOR)
          .collaborationAsset.resolve({
            roomId: room.roomId,
            fileIds: ["abcdef0123456789abcdef0123456789abcdef01"],
          })
          .catch((error: unknown) => error);
        expect(codeOf(outcome)).not.toBe("TOO_MANY_REQUESTS");
      });

      it("takes exactly one Redis call, with no inline retry", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        limitCalls.length = 0;
        await callerFor(EDITOR).collaborationAsset.resolve({
          roomId: room.roomId,
          fileIds: ["abcdef0123456789abcdef0123456789abcdef01"],
        });
        expect(limitCalls).toHaveLength(1);
      });
    });
  }
});
