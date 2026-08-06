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

const { pgClient, testDb } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const testSchema = await import("@/server/db/schema");
  const pgClient = new PGlite();
  return {
    pgClient,
    testDb: drizzle(pgClient, { schema: testSchema }),
  };
});

vi.mock("@/server/db/index", () => ({ db: testDb }));

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import { QUERIES } from "@/server/db/queries";
import {
  createQueueDrainJob,
  createUnreferencedAssetGcJob,
  createUserPurgeJob,
  expiredSessionsJob,
  MaintenanceJobError,
  runMaintenanceJobs,
  type MaintenanceDeps,
  type MaintenanceJob,
} from "@/server/maintenance/jobs";
import { compressData } from "@/lib/encode";
import {
  createOwnedSceneDocumentV4,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

const OWNER = "user-owner";
const OWNER_EMAIL = "owner@example.com";
const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);
const DAY_MS = 24 * 60 * 60 * 1000;

const imageElement = (fileId: string, id: string): ExcalidrawElement =>
  ({
    id,
    type: "image",
    fileId,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    strokeColor: "#000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: "a0",
  }) as unknown as ExcalidrawElement;

async function storedScene(
  elements: readonly ExcalidrawElement[],
): Promise<string> {
  const document = createOwnedSceneDocumentV4({
    elements,
    appState: {},
    files: {},
  });
  const compressed = await compressData(
    new TextEncoder().encode(serializeDrawstuffDocumentV4(document)),
    { encryptionKey: null },
  );
  return Buffer.from(compressed).toString("base64");
}

/** Deps whose storage deletion can be told to fail for chosen keys. */
function makeDeps(options?: { failKeys?: () => Set<string> }) {
  const deletedKeys: string[] = [];
  const deps: MaintenanceDeps = {
    deleteStorageFile: (key) => {
      if (options?.failKeys?.().has(key)) {
        return Promise.reject(new Error(`storage refused ${key}`));
      }
      deletedKeys.push(key);
      return Promise.resolve();
    },
    now: () => new Date(),
  };
  return { deps, deletedKeys };
}

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
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.session);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb
    .insert(schema.user)
    .values({ id: OWNER, name: "Owner", email: OWNER_EMAIL });
});

async function insertScene(sceneData: string | null) {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId: OWNER, sceneData })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

const record = (
  sceneId: string,
  fileId: string,
  utFileKey: string,
  createdAt = new Date(Date.now() - 2 * DAY_MS),
) =>
  testDb.insert(schema.fileRecord).values({
    sceneId,
    ownerId: OWNER,
    utFileKey,
    excalidrawFileId: fileId,
    size: 32,
    url: `https://files.example/${utFileKey}`,
    createdAt,
  });

const recordKeys = async (sceneId: string) =>
  (
    await testDb
      .select({ utFileKey: schema.fileRecord.utFileKey })
      .from(schema.fileRecord)
      .where(eq(schema.fileRecord.sceneId, sceneId))
  ).map((row) => row.utFileKey);

describe("runMaintenanceJobs", () => {
  it("keeps running the jobs behind a failing one and reports which failed", async () => {
    const ran: string[] = [];
    const failing: MaintenanceJob = {
      name: "broken",
      run: () => Promise.reject(new Error("boom")),
    };
    const witness: MaintenanceJob = {
      name: "witness",
      run: () => {
        ran.push("witness");
        return Promise.resolve({ ok: true });
      },
    };

    const { deps } = makeDeps();
    const report = await runMaintenanceJobs(
      [failing, witness, expiredSessionsJob],
      deps,
    );

    expect(ran).toEqual(["witness"]);
    expect(report.failed).toBe(1);
    expect(report.jobs.map((job) => [job.name, job.status])).toEqual([
      ["broken", "error"],
      ["witness", "ok"],
      ["expired-sessions", "ok"],
    ]);
    const broken = report.jobs[0];
    if (broken?.status !== "error") throw new Error("expected error outcome");
    expect(broken.error).toContain("boom");
  });

  it("drains keys enqueued by an earlier job in the same run", async () => {
    // GC enqueues the reclaimed key; the drain, running last in the same run,
    // must delete the object in that run — not the following week.
    const sceneId = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(sceneId, FILE_A, "key-a");
    await record(sceneId, FILE_B, "key-b");

    const { deps, deletedKeys } = makeDeps();
    const report = await runMaintenanceJobs(
      [createUnreferencedAssetGcJob(), createQueueDrainJob()],
      deps,
    );

    expect(report.failed).toBe(0);
    const drain = report.jobs.at(-1);
    if (drain?.status !== "ok") throw new Error("expected drain to succeed");
    expect(drain.detail.processed).toBe(1);
    expect(drain.detail.remaining).toBe(0);
    expect(deletedKeys).toEqual(["key-b"]);
  });

  it("attaches a failing job's partial detail to its error outcome", async () => {
    const partial: MaintenanceJob = {
      name: "partial",
      run: () =>
        Promise.reject(
          new MaintenanceJobError("half done", { completed: ["a"] }),
        ),
    };

    const { deps } = makeDeps();
    const report = await runMaintenanceJobs([partial], deps);

    expect(report.jobs[0]).toMatchObject({
      name: "partial",
      status: "error",
      detail: { completed: ["a"] },
    });
  });
});

describe("unreferenced asset GC", () => {
  it("reclaims records the committed document no longer references", async () => {
    const sceneId = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(sceneId, FILE_A, "key-a");
    await record(sceneId, FILE_B, "key-b");

    const { deps, deletedKeys } = makeDeps();
    const job = createUnreferencedAssetGcJob();
    const first = await job.run(deps);

    expect(first).toMatchObject({
      deletedRecords: 1,
      enqueuedObjects: 1,
      unreadableScenes: 0,
      truncated: false,
    });
    expect(await recordKeys(sceneId)).toEqual(["key-a"]);
    // The object's key survives durably in the queue (crash-safe), and the
    // GC itself touches no storage.
    expect(deletedKeys).toEqual([]);
    const queued = await testDb.select().from(schema.deferredFileCleanup);
    expect(
      queued.map((task) => [task.utFileKey, task.reason, task.status]),
    ).toEqual([["key-b", "unreferenced-asset-gc", "pending"]]);

    // Idempotent: a rerun after a full sweep reclaims nothing.
    const second = await job.run(deps);
    expect(second).toMatchObject({ deletedRecords: 0, enqueuedObjects: 0 });
    expect(await recordKeys(sceneId)).toEqual(["key-a"]);
  });

  it("leaves records younger than the grace period alone", async () => {
    const sceneId = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(sceneId, FILE_A, "key-a");
    await record(sceneId, FILE_B, "key-b-fresh", new Date());

    const { deps, deletedKeys } = makeDeps();
    const detail = await createUnreferencedAssetGcJob().run(deps);

    expect(detail).toMatchObject({ deletedRecords: 0 });
    expect(deletedKeys).toEqual([]);
    expect((await recordKeys(sceneId)).sort()).toEqual([
      "key-a",
      "key-b-fresh",
    ]);
  });

  it("retains everything under an unreadable document", async () => {
    const sceneId = await insertScene("not-a-document");
    await record(sceneId, FILE_A, "key-a");

    const { deps, deletedKeys } = makeDeps();
    const detail = await createUnreferencedAssetGcJob().run(deps);

    expect(detail).toMatchObject({ deletedRecords: 0, unreadableScenes: 1 });
    expect(deletedKeys).toEqual([]);
    expect(await recordKeys(sceneId)).toEqual(["key-a"]);
  });

  it("stops at the record cap and reports the run as truncated", async () => {
    const sceneId = await insertScene(await storedScene([]));
    await record(sceneId, FILE_A, "key-a");
    await record(sceneId, FILE_B, "key-b");

    const { deps } = makeDeps();
    const detail = await createUnreferencedAssetGcJob({ maxRecords: 1 }).run(
      deps,
    );

    expect(detail).toMatchObject({ deletedRecords: 1, truncated: true });
    expect(await recordKeys(sceneId)).toHaveLength(1);
  });

});

describe("bounded queue drain", () => {
  it("drains up to the task cap and reports what is left", async () => {
    for (let i = 0; i < 5; i += 1) {
      await QUERIES.enqueueDeferredCleanup({
        utFileKey: `key-${i}`,
        reason: "test",
      });
    }

    const { deps } = makeDeps();
    const detail = await createQueueDrainJob({
      batchSize: 2,
      maxTasks: 3,
    }).run(deps);

    expect(detail).toMatchObject({ processed: 3, remaining: 2 });
  });

  it("stops when the wall-clock budget is spent", async () => {
    await QUERIES.enqueueDeferredCleanup({ utFileKey: "key-0", reason: "t" });

    const { deps } = makeDeps();
    const detail = await createQueueDrainJob({ budgetMs: 0 }).run({
      ...deps,
      now: () => new Date(),
    });

    expect(detail).toMatchObject({
      processed: 0,
      remaining: 1,
      exhaustedBudget: true,
    });
  });

  it("marks a task failed after its attempts are exhausted", async () => {
    await QUERIES.enqueueDeferredCleanup({ utFileKey: "key-x", reason: "t" });
    await testDb
      .update(schema.deferredFileCleanup)
      .set({ attempts: 5 })
      .where(eq(schema.deferredFileCleanup.utFileKey, "key-x"));

    const { deps } = makeDeps({ failKeys: () => new Set(["key-x"]) });
    const detail = await createQueueDrainJob().run(deps);

    expect(detail).toMatchObject({ processed: 0, failed: 1, remaining: 0 });
    const [task] = await testDb.select().from(schema.deferredFileCleanup);
    expect(task?.status).toBe("failed");
  });
});

describe("user purge", () => {
  const seedOtherUser = async () => {
    await testDb
      .insert(schema.user)
      .values({ id: "intruder", name: "Intruder", email: "x@example.com" });
    const [row] = await testDb
      .insert(schema.scene)
      .values({
        name: "theirs",
        userId: "intruder",
        thumbnailFileKey: "thumb-x",
      })
      .returning({ id: schema.scene.id });
    if (!row) throw new Error("failed to insert scene");
    await testDb.insert(schema.fileRecord).values({
      sceneId: row.id,
      ownerId: "intruder",
      utFileKey: "key-x",
      excalidrawFileId: FILE_A,
      size: 32,
      url: "https://files.example/key-x",
    });
  };

  const userIds = async () =>
    (await testDb.select({ id: schema.user.id }).from(schema.user)).map(
      (row) => row.id,
    );

  it("refuses to run without a matching confirmation", async () => {
    await seedOtherUser();
    const { deps, deletedKeys } = makeDeps();
    const report = await runMaintenanceJobs(
      [
        createUserPurgeJob({
          keepOwnerEmail: OWNER_EMAIL,
          confirmKeepOwnerEmail: "wrong@example.com",
          dryRun: false,
        }),
      ],
      deps,
    );

    expect(report.failed).toBe(1);
    expect((await userIds()).sort()).toEqual(["intruder", OWNER]);
    expect(deletedKeys).toEqual([]);
  });

  it("dry-run reports the blast radius without writing", async () => {
    await seedOtherUser();
    const { deps, deletedKeys } = makeDeps();
    const detail = await createUserPurgeJob({
      keepOwnerEmail: OWNER_EMAIL,
      confirmKeepOwnerEmail: OWNER_EMAIL,
      dryRun: true,
    }).run(deps);

    expect(detail).toMatchObject({ dryRun: true, users: 1 });
    expect(detail.accounts).toEqual([
      {
        userId: "intruder",
        email: "x@example.com",
        scenes: 1,
        assetObjects: 1,
        thumbnailObjects: 1,
        status: "dry-run",
      },
    ]);
    expect((await userIds()).sort()).toEqual(["intruder", OWNER]);
    expect(deletedKeys).toEqual([]);
    expect(await testDb.select().from(schema.deferredFileCleanup)).toEqual([]);
  });

  it("deletes non-owner accounts and their objects when confirmed", async () => {
    await seedOtherUser();
    const { deps, deletedKeys } = makeDeps();
    const detail = await createUserPurgeJob({
      keepOwnerEmail: OWNER_EMAIL,
      confirmKeepOwnerEmail: OWNER_EMAIL,
      dryRun: false,
    }).run(deps);

    expect(detail).toMatchObject({
      dryRun: false,
      users: 1,
      deletedObjects: 2,
      enqueuedObjects: 0,
    });
    expect(await userIds()).toEqual([OWNER]);
    expect(deletedKeys.sort()).toEqual(["key-x", "thumb-x"]);
    // Cascade removed the intruder's scene and records.
    expect(await testDb.select().from(schema.scene)).toEqual([]);
    expect(await testDb.select().from(schema.fileRecord)).toEqual([]);
  });
});
