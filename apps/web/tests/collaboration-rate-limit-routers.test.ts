// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

import type { Ratelimit as UpstashRatelimit } from "@upstash/ratelimit";

vi.mock("server-only", () => ({}));

vi.mock("@/server/collab/do-control", () => ({
  pushDoRoomControl: () =>
    Promise.resolve({ enforced: true, closedSessions: 0 }),
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
let scriptedResponses: ScriptedResponse[] = [];

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
      const response = scriptedResponses.shift() ?? scripted;
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
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { TRPCError } from "@trpc/server";

import { sealRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import {
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  SNAPSHOT_CRYPTO_VERSION,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";

import { appRouter, createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import * as schema from "@/server/db/schema";
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

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const STRANGER = "user-stranger";

const contextFor = (userId: string | null): TRPCContext =>
  ({
    db: testDb,
    headers: new Headers(),
    auth: userId
      ? { session: { id: `session-${userId}` }, user: { id: userId } }
      : null,
  }) as unknown as TRPCContext;

const callerFor = (userId: string | null) => createCaller(contextFor(userId));

const allow = (): void => {
  scriptedResponses = [];
  scripted = { success: true, limit: 20, remaining: 19, reset: 60_000 };
};
const refuse = (reset: number): void => {
  scriptedResponses = [];
  scripted = { success: false, limit: 20, remaining: 0, reset };
};
const script = (...responses: ScriptedResponse[]): void => {
  scriptedResponses = [...responses];
};

async function createScene(userId: string): Promise<string> {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId, sceneData: "stub" })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

async function openRoom(options: { linkRole?: "none" | "editor" } = {}) {
  const sceneId = await createScene(OWNER);
  const room = await callerFor(OWNER).collaborationRoom.create({
    sceneId,
    linkRole: options.linkRole ?? "none",
  });
  await callerFor(OWNER).collaborationRoom.setKeyCheck({
    roomId: room.roomId,
    authGeneration: room.authGeneration,
    keyCheckBase64: await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: room.authGeneration,
    }),
  });
  return room;
}

const grant = (roomId: string, userId: string, role: "editor" | "viewer") =>
  callerFor(OWNER).collaborationRoom.setMemberRole({ roomId, userId, role });

const ciphertext = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength).fill(7);
  bytes[0] = SNAPSHOT_CRYPTO_VERSION;
  return Buffer.from(bytes).toString("base64");
};

const put = (
  userId: string,
  input: { roomId: string; authGeneration?: number; byteLength?: number },
) =>
  callerFor(userId).collaborationSnapshot.put({
    roomId: input.roomId,
    intent: "cadence",
    authGeneration: input.authGeneration ?? 1,
    expectedRevision: SNAPSHOT_NO_REVISION,
    cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
    ciphertextBase64: ciphertext(input.byteLength ?? 64),
    checksum: "ab".padEnd(64, "0").replace(/[^0-9a-f]/g, "a"),
  });

const codeOf = (error: unknown): string | undefined =>
  error instanceof TRPCError ? error.code : undefined;

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});

afterAll(async () => {
  await client.close();
});

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
      callerFor(null).collaborationRoom.join({ roomId: "room-anything" }),
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
      callerFor(EDITOR).collaborationRoom.join({ roomId: "room-missing" }),
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

  it("will not let a stranger spend a room's snapshot budget", async () => {
    const room = await openRoom();
    limitCalls.length = 0;
    // Room-scoped budget: if the limiter ran before access resolution, anybody
    // holding a room id could exhaust that room's writes for a minute.
    await expect(put(STRANGER, { roomId: room.roomId })).rejects.toSatisfy(
      (error) => codeOf(error) === "FORBIDDEN",
    );
    expect(limitCalls).toEqual([]);
  });

  it("will not let a viewer spend the room's snapshot budget", async () => {
    const room = await openRoom();
    await grant(room.roomId, VIEWER, "viewer");
    limitCalls.length = 0;
    await expect(put(VIEWER, { roomId: room.roomId })).rejects.toSatisfy(
      (error) => codeOf(error) === "FORBIDDEN",
    );
    expect(limitCalls).toEqual([]);
  });

  it("charges an authorized snapshot write to the room, not to the writer", async () => {
    const room = await openRoom();
    await grant(room.roomId, EDITOR, "editor");
    limitCalls.length = 0;
    await put(EDITOR, { roomId: room.roomId });
    // The identifier is the canonical room id from the resolved row, never a
    // string the caller chose.
    expect(limitCalls).toEqual([
      { operation: "snapshot-put", identifier: room.roomId },
    ]);
  });

  it("uses the user-room finalization reserve only after the room budget refuses a leave", async () => {
    const room = await openRoom();
    await grant(room.roomId, EDITOR, "editor");
    limitCalls.length = 0;
    const reset = Date.now() + 30_000;
    script(
      { success: false, limit: 6, remaining: 0, reset },
      { success: true, limit: 2, remaining: 1, reset },
    );

    await callerFor(EDITOR).collaborationSnapshot.put({
      roomId: room.roomId,
      intent: "leave",
      authGeneration: room.authGeneration,
      expectedRevision: SNAPSHOT_NO_REVISION,
      cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
      ciphertextBase64: ciphertext(64),
      checksum: "ab".padEnd(64, "0"),
    });

    expect(limitCalls).toEqual([
      { operation: "snapshot-put", identifier: room.roomId },
      {
        operation: "snapshot-finalize",
        identifier: JSON.stringify([room.roomId, EDITOR]),
      },
    ]);
  });

  it("does not let cadence writes use the finalization reserve", async () => {
    const room = await openRoom();
    await grant(room.roomId, EDITOR, "editor");
    limitCalls.length = 0;
    refuse(Date.now() + 30_000);

    await expect(put(EDITOR, { roomId: room.roomId })).rejects.toSatisfy(
      (error) => codeOf(error) === "TOO_MANY_REQUESTS",
    );
    expect(limitCalls).toEqual([
      { operation: "snapshot-put", identifier: room.roomId },
    ]);
  });

  it("still returns 429 when both leave budgets are spent", async () => {
    const room = await openRoom();
    await grant(room.roomId, EDITOR, "editor");
    limitCalls.length = 0;
    refuse(Date.now() + 30_000);

    await expect(
      callerFor(EDITOR).collaborationSnapshot.put({
        roomId: room.roomId,
        intent: "leave",
        authGeneration: room.authGeneration,
        expectedRevision: SNAPSHOT_NO_REVISION,
        cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
        ciphertextBase64: ciphertext(64),
        checksum: "ab".padEnd(64, "0"),
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === "TOO_MANY_REQUESTS");
    expect(limitCalls.map(({ operation }) => operation)).toEqual([
      "snapshot-put",
      "snapshot-finalize",
    ]);
  });

  it("refuses an oversize snapshot before spending the room's budget", async () => {
    const room = await openRoom();
    await grant(room.roomId, EDITOR, "editor");
    limitCalls.length = 0;
    await expect(
      put(EDITOR, {
        roomId: room.roomId,
        byteLength: MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1,
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === "BAD_REQUEST");
    expect(limitCalls).toEqual([]);
  });
});

describe("a real refusal", () => {
  it("is TOO_MANY_REQUESTS carrying the reset instant and the wait", async () => {
    const reset = Date.now() + 45_000;
    refuse(reset);
    const error = await callerFor(EDITOR)
      .collaborationRoom.join({ roomId: "room-a" })
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
        "http://localhost/api/trpc/collaborationRoom.join?batch=1",
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
        "http://localhost/api/trpc/collaborationRoom.join?batch=1",
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

    expect(response.status).toBe(404);
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

      it("lets an authorized snapshot write through instead of returning 429", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        await expect(put(EDITOR, { roomId: room.roomId })).resolves.toEqual({
          status: "written",
          revision: 1,
        });
      });

      it("still refuses a viewer's snapshot write", async () => {
        const room = await openRoom();
        await grant(room.roomId, VIEWER, "viewer");
        scripted = script;
        await expect(put(VIEWER, { roomId: room.roomId })).rejects.toSatisfy(
          (error) => codeOf(error) === "FORBIDDEN",
        );
      });

      it("still refuses a stranger's snapshot write", async () => {
        const room = await openRoom();
        scripted = script;
        await expect(put(STRANGER, { roomId: room.roomId })).rejects.toSatisfy(
          (error) => codeOf(error) === "FORBIDDEN",
        );
      });

      it("still refuses a write sealed under a retired generation", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        await expect(
          put(EDITOR, { roomId: room.roomId, authGeneration: 2 }),
        ).rejects.toSatisfy((error) => codeOf(error) === "PRECONDITION_FAILED");
      });

      it("still refuses an oversize snapshot", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        await expect(
          put(EDITOR, {
            roomId: room.roomId,
            byteLength: MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1,
          }),
        ).rejects.toSatisfy((error) => codeOf(error) === "BAD_REQUEST");
      });

      it("still refuses an unauthenticated join", async () => {
        await expect(
          callerFor(null).collaborationRoom.join({ roomId: "room-a" }),
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
        const outcome = await put(EDITOR, { roomId: room.roomId }).catch(
          (error: unknown) => error,
        );
        expect(codeOf(outcome)).not.toBe("TOO_MANY_REQUESTS");
      });

      it("takes exactly one Redis call, with no inline retry", async () => {
        const room = await openRoom();
        await grant(room.roomId, EDITOR, "editor");
        scripted = script;
        limitCalls.length = 0;
        await put(EDITOR, { roomId: room.roomId });
        expect(limitCalls).toHaveLength(1);
      });
    });
  }
});
