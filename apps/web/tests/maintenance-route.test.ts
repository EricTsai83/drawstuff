// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const OWNER_EMAIL = "owner@example.com";
const SECRET = "test-cron-secret";

const { pgClient, testDb, lockState, deletedObjectKeys } = await vi.hoisted(
  async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const testSchema = await import("@/server/db/schema");
    const pgClient = new PGlite();
    return {
      pgClient,
      testDb: drizzle(pgClient, { schema: testSchema }),
      lockState: { locked: true, acquired: 0, released: 0, ended: 0 },
      deletedObjectKeys: [] as string[],
    };
  },
);

vi.mock("@/server/db/index", () => ({ db: testDb }));
vi.mock("@/env", () => ({
  env: {
    CRON_SECRET: "test-cron-secret",
    CLEANUP_OWNER_EMAIL: "owner@example.com",
    POSTGRES_URL: "postgres://pooled-unused",
    POSTGRES_URL_NON_POOLING: "postgres://direct-unused",
  },
}));
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles(keys: string[]) {
      deletedObjectKeys.push(...keys);
      return Promise.resolve({ success: true });
    }
  },
}));
// The route takes its advisory lock on a dedicated connection; here that
// connection is a stub whose lock answer the tests control.
vi.mock("postgres", () => ({
  default: () => {
    const sql = (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("pg_try_advisory_lock")) {
        lockState.acquired += 1;
        return Promise.resolve([{ locked: lockState.locked }]);
      }
      if (text.includes("pg_advisory_unlock")) {
        lockState.released += 1;
        return Promise.resolve([{ unlocked: true }]);
      }
      return Promise.resolve([]);
    };
    (sql as unknown as { end: () => Promise<void> }).end = () => {
      lockState.ended += 1;
      return Promise.resolve();
    };
    return sql;
  },
}));

import { pushSchema } from "drizzle-kit/api";

import * as schema from "@/server/db/schema";
import * as route from "@/app/api/maintenance/cleanup/route";

type MaintenanceResponse = {
  jobs?: Array<{ name: string; status: string }>;
  failed?: number;
  skipped?: string;
  error?: string;
};

const post = (init?: { secret?: string; body?: unknown }) =>
  route.POST(
    new Request("http://localhost/api/maintenance/cleanup", {
      method: "POST",
      headers: {
        authorization: `Bearer ${init?.secret ?? SECRET}`,
        "content-type": "application/json",
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});

afterAll(async () => {
  await pgClient.close();
});

beforeEach(async () => {
  lockState.locked = true;
  lockState.acquired = 0;
  lockState.released = 0;
  lockState.ended = 0;
  deletedObjectKeys.length = 0;
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb
    .insert(schema.user)
    .values({ id: "owner", name: "Owner", email: OWNER_EMAIL });
});

const get = (init?: { secret?: string }) =>
  route.GET(
    new Request("http://localhost/api/maintenance/cleanup", {
      method: "GET",
      headers: { authorization: `Bearer ${init?.secret ?? SECRET}` },
    }),
  );

describe("maintenance cleanup route", () => {
  it("rejects a wrong bearer token", async () => {
    const response = await post({ secret: "wrong" });
    expect(response.status).toBe(401);
    const getResponse = await get({ secret: "wrong" });
    expect(getResponse.status).toBe(401);
  });

  it("GET (the Vercel cron shape) runs exactly the routine jobs", async () => {
    // Vercel Cron only issues GET, so this entry point must work — but it can
    // never carry the user-purge opt-in.
    await testDb
      .insert(schema.user)
      .values({ id: "intruder", name: "X", email: "x@example.com" });

    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as MaintenanceResponse;

    expect(body.jobs?.map((job) => job.name)).toEqual([
      "expired-shared-scenes",
      "unreferenced-asset-gc",
      "collab-room-retention",
      "expired-sessions",
      "expired-verifications",
      "purge-finished-queue-rows",
      "drain-cleanup-queue",
    ]);
    expect(await testDb.select().from(schema.user)).toHaveLength(2);
  });

  it("runs the routine jobs in order, queue drain last, and reports per job", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const body = (await response.json()) as MaintenanceResponse;

    expect(body.failed).toBe(0);
    expect(body.jobs?.map((job) => job.name)).toEqual([
      "expired-shared-scenes",
      "unreferenced-asset-gc",
      "collab-room-retention",
      "expired-sessions",
      "expired-verifications",
      "purge-finished-queue-rows",
      "drain-cleanup-queue",
    ]);
    expect(lockState.released).toBe(1);
    expect(lockState.ended).toBe(1);
  });

  it("skips the whole run when the advisory lock is taken", async () => {
    lockState.locked = false;
    // A record the GC would otherwise reclaim: nothing may touch it.
    const [row] = await testDb
      .insert(schema.scene)
      .values({ name: "scene", userId: "owner" })
      .returning({ id: schema.scene.id });
    if (!row) throw new Error("failed to insert scene");
    await testDb.insert(schema.fileRecord).values({
      sceneId: row.id,
      ownerId: "owner",
      utFileKey: "key-a",
      excalidrawFileId: "a".repeat(40),
      size: 32,
      url: "https://files.example/key-a",
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });

    const response = await post();
    const body = (await response.json()) as MaintenanceResponse;

    expect(body).toEqual({ skipped: "already-running" });
    expect(deletedObjectKeys).toEqual([]);
    expect(await testDb.select().from(schema.fileRecord)).toHaveLength(1);
    expect(lockState.ended).toBe(1);
  });

  it("rejects a malformed body", async () => {
    const response = await post({ body: { userPurge: { dryRun: true } } });
    expect(response.status).toBe(400);
  });

  it("never runs the user purge on a bodyless cron call", async () => {
    await testDb
      .insert(schema.user)
      .values({ id: "intruder", name: "X", email: "x@example.com" });

    const response = await post();
    const body = (await response.json()) as MaintenanceResponse;

    expect(body.jobs?.some((job) => job.name === "purge-non-owner-users")).toBe(
      false,
    );
    expect(await testDb.select().from(schema.user)).toHaveLength(2);
  });

  it("reports a failing purge confirmation without stopping the routine jobs", async () => {
    const response = await post({
      body: {
        userPurge: {
          confirmKeepOwnerEmail: "wrong@example.com",
          dryRun: false,
        },
      },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as MaintenanceResponse;

    expect(body.failed).toBe(1);
    expect(body.jobs?.[0]).toMatchObject({
      name: "purge-non-owner-users",
      status: "error",
    });
    // The failure is isolated: everything behind it still ran.
    expect(body.jobs?.slice(1).every((job) => job.status === "ok")).toBe(true);
  });

  it("runs a confirmed dry-run purge before the routine jobs", async () => {
    await testDb
      .insert(schema.user)
      .values({ id: "intruder", name: "X", email: "x@example.com" });

    const response = await post({
      body: { userPurge: { confirmKeepOwnerEmail: OWNER_EMAIL } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as MaintenanceResponse;

    expect(body.jobs?.[0]).toMatchObject({
      name: "purge-non-owner-users",
      status: "ok",
    });
    // dryRun defaults to true: the intruder survives.
    expect(await testDb.select().from(schema.user)).toHaveLength(2);
  });
});
