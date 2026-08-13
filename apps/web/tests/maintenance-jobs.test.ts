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
  createRoomRetentionJob,
  createUnreferencedAssetGcJob,
  createUserPurgeJob,
  expiredSessionsJob,
  MaintenanceJobError,
  ROOM_RETENTION_CLEANUP_REASON,
  routineMaintenanceJobs,
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
  await testDb.delete(schema.collaborationAsset);
  await testDb.delete(schema.collaborationSnapshot);
  await testDb.delete(schema.collaborationRoom);
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

  it("stops at the absolute deadline even with wall-clock budget left", async () => {
    // The route hands the drain a deadline inside its execution envelope; a
    // long pre-drain run must shrink the drain, not push the route past its
    // maxDuration.
    await QUERIES.enqueueDeferredCleanup({ utFileKey: "key-0", reason: "t" });

    const { deps } = makeDeps();
    const detail = await createQueueDrainJob({
      deadlineAt: new Date(Date.now() - 1),
    }).run(deps);

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

describe("collab room retention", () => {
  const HOUR_MS = 60 * 60 * 1000;

  async function insertRoom(params: {
    roomId: string;
    status: "active" | "ended";
    expiresAt: Date;
    endedAt?: Date;
  }) {
    const sceneId = await insertScene(null);
    await testDb.insert(schema.collaborationRoom).values({
      roomId: params.roomId,
      sceneId,
      ownerId: OWNER,
      status: params.status,
      expiresAt: params.expiresAt,
      endedAt: params.endedAt ?? null,
    });
  }

  const insertSnapshot = (roomId: string, byteLength = 8) =>
    testDb.insert(schema.collaborationSnapshot).values({
      roomId,
      authGeneration: 1,
      revision: 1,
      cryptoVersion: 1,
      ciphertext: new Uint8Array(byteLength),
      byteLength,
      checksum: "c".repeat(64),
    });

  const insertAsset = (roomId: string, fileId: string, utFileKey: string) =>
    testDb.insert(schema.collaborationAsset).values({
      roomId,
      authGeneration: 1,
      excalidrawFileId: fileId,
      cryptoVersion: 1,
      utFileKey,
      url: `https://files.example/${utFileKey}`,
      byteLength: 16,
    });

  const roomRow = async (roomId: string) =>
    (
      await testDb
        .select()
        .from(schema.collaborationRoom)
        .where(eq(schema.collaborationRoom.roomId, roomId))
    )[0];

  const snapshotCount = async (roomId: string) =>
    (
      await testDb
        .select()
        .from(schema.collaborationSnapshot)
        .where(eq(schema.collaborationSnapshot.roomId, roomId))
    ).length;

  const assetCount = async (roomId: string) =>
    (
      await testDb
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.roomId, roomId))
    ).length;

  it("reclaims an ended room past the grace period and drains its objects in the same run", async () => {
    await insertRoom({
      roomId: "room-ended-old",
      status: "ended",
      expiresAt: new Date(Date.now() - 9 * DAY_MS),
      endedAt: new Date(Date.now() - 8 * DAY_MS),
    });
    await insertSnapshot("room-ended-old", 8);
    await insertAsset("room-ended-old", FILE_A, "room-key-a");
    await insertAsset("room-ended-old", FILE_B, "room-key-b");

    const { deps, deletedKeys } = makeDeps();
    const report = await runMaintenanceJobs(
      [createRoomRetentionJob(), createQueueDrainJob()],
      deps,
    );

    expect(report.failed).toBe(0);
    const retention = report.jobs[0];
    if (retention?.status !== "ok") throw new Error("expected retention ok");
    expect(retention.detail).toMatchObject({
      roomsReclaimed: 1,
      endedExpiredRooms: 0,
      deletedSnapshots: 1,
      deletedSnapshotBytes: 8,
      deletedAssetRows: 2,
      enqueuedObjects: 2,
      truncated: false,
    });
    expect(await snapshotCount("room-ended-old")).toBe(0);
    expect(await assetCount("room-ended-old")).toBe(0);
    // The room row stays as history; the storage objects went through the
    // queue and were deleted by the drain in the same run.
    expect((await roomRow("room-ended-old"))?.status).toBe("ended");
    expect(deletedKeys.sort()).toEqual(["room-key-a", "room-key-b"]);
    const queued = await testDb.select().from(schema.deferredFileCleanup);
    expect(queued.map((task) => [task.reason, task.status])).toEqual([
      [ROOM_RETENTION_CLEANUP_REASON, "done"],
      [ROOM_RETENTION_CLEANUP_REASON, "done"],
    ]);

    // Idempotent: the swept room no longer holds data, so a rerun finds nothing.
    const second = await createRoomRetentionJob().run(deps);
    expect(second).toMatchObject({ roomsReclaimed: 0, enqueuedObjects: 0 });
  });

  it("leaves live and recently ended or expired rooms alone", async () => {
    await insertRoom({
      roomId: "room-live",
      status: "active",
      expiresAt: new Date(Date.now() + 12 * HOUR_MS),
    });
    await insertRoom({
      roomId: "room-just-expired",
      status: "active",
      expiresAt: new Date(Date.now() - HOUR_MS),
    });
    await insertRoom({
      roomId: "room-just-ended",
      status: "ended",
      expiresAt: new Date(Date.now() + 12 * HOUR_MS),
      endedAt: new Date(Date.now() - HOUR_MS),
    });
    for (const roomId of [
      "room-live",
      "room-just-expired",
      "room-just-ended",
    ]) {
      await insertSnapshot(roomId);
      await insertAsset(roomId, FILE_A, `${roomId}-key`);
    }

    const { deps, deletedKeys } = makeDeps();
    const detail = await createRoomRetentionJob().run(deps);

    expect(detail).toMatchObject({ roomsReclaimed: 0, enqueuedObjects: 0 });
    expect(deletedKeys).toEqual([]);
    for (const roomId of [
      "room-live",
      "room-just-expired",
      "room-just-ended",
    ]) {
      expect(await snapshotCount(roomId)).toBe(1);
      expect(await assetCount(roomId)).toBe(1);
    }
    expect((await roomRow("room-just-expired"))?.status).toBe("active");
    expect(await testDb.select().from(schema.deferredFileCleanup)).toEqual([]);
  });

  it("ends an expired-but-active room before reclaiming it", async () => {
    // The create mutation refreshes an expired active room back to life
    // (same roomId), so a reclaimed room must be closed in the same
    // transaction — otherwise it could be resurrected with its baseline and
    // assets already gone.
    await insertRoom({
      roomId: "room-expired-old",
      status: "active",
      expiresAt: new Date(Date.now() - 8 * DAY_MS),
    });
    await insertSnapshot("room-expired-old");
    await insertAsset("room-expired-old", FILE_A, "expired-key");

    const { deps } = makeDeps();
    const detail = await createRoomRetentionJob().run(deps);

    expect(detail).toMatchObject({
      roomsReclaimed: 1,
      endedExpiredRooms: 1,
      deletedSnapshots: 1,
      enqueuedObjects: 1,
    });
    const room = await roomRow("room-expired-old");
    expect(room?.status).toBe("ended");
    expect(room?.endedAt).not.toBeNull();
    expect(await snapshotCount("room-expired-old")).toBe(0);
    expect(await assetCount("room-expired-old")).toBe(0);
  });

  it("ends a long-expired room that holds no data", async () => {
    // As long as it stays active the create mutation can refresh it back to
    // life, so ending it after the grace period is retention work even with
    // nothing to reclaim.
    await insertRoom({
      roomId: "room-empty-expired",
      status: "active",
      expiresAt: new Date(Date.now() - 8 * DAY_MS),
    });

    const { deps } = makeDeps();
    const first = await createRoomRetentionJob().run(deps);
    expect(first).toMatchObject({
      roomsReclaimed: 0,
      endedExpiredRooms: 1,
      enqueuedObjects: 0,
    });
    const room = await roomRow("room-empty-expired");
    expect(room?.status).toBe("ended");
    expect(room?.endedAt).not.toBeNull();

    // Ended and data-less, it is no longer a candidate.
    const second = await createRoomRetentionJob().run(deps);
    expect(second).toMatchObject({ endedExpiredRooms: 0 });
  });

  it("drains what the asset GC and room retention enqueue in one routine run", async () => {
    // Review pass 2 finding: the drain's task cap must cover every producer's
    // aggregate, not just one job's. Both producers enqueue here and the
    // routine run's own drain clears both.
    const sceneId = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(sceneId, FILE_A, "key-a");
    await record(sceneId, FILE_B, "key-b");
    await insertRoom({
      roomId: "room-combo",
      status: "ended",
      expiresAt: new Date(Date.now() - 9 * DAY_MS),
      endedAt: new Date(Date.now() - 8 * DAY_MS),
    });
    await insertAsset("room-combo", FILE_A, "room-combo-key");

    const { deps, deletedKeys } = makeDeps();
    const report = await runMaintenanceJobs(routineMaintenanceJobs(), deps);

    expect(report.failed).toBe(0);
    const drain = report.jobs.at(-1);
    if (drain?.status !== "ok") throw new Error("expected drain to succeed");
    expect(drain.detail).toMatchObject({ processed: 2, remaining: 0 });
    expect(deletedKeys.sort()).toEqual(["key-b", "room-combo-key"]);
  });

  it("defers rooms past the object budget so the same run's drain can keep up", async () => {
    // Review pass 1 finding: the drain after this job is itself bounded, so a
    // run must not enqueue more than that drain can take. Rooms are processed
    // whole; the first room may exceed the budget alone (per-room rows are
    // schema-bounded) rather than starve forever.
    for (const [index, roomId] of [
      "room-budget-1",
      "room-budget-2",
    ].entries()) {
      await insertRoom({
        roomId,
        status: "ended",
        expiresAt: new Date(Date.now() - 9 * DAY_MS),
        endedAt: new Date(Date.now() - 8 * DAY_MS),
      });
      await insertAsset(roomId, FILE_A, `${roomId}-key-a`);
      await insertAsset(
        roomId,
        `${index}${FILE_B.slice(1)}`,
        `${roomId}-key-b`,
      );
    }

    const { deps } = makeDeps();
    // Budget of 1 < first room's 2 assets: the first room is still reclaimed
    // whole, the second is deferred and the run reports truncation.
    const first = await createRoomRetentionJob({ maxAssetObjects: 1 }).run(
      deps,
    );
    expect(first).toMatchObject({
      roomsReclaimed: 1,
      enqueuedObjects: 2,
      truncated: true,
    });
    expect(
      (await assetCount("room-budget-1")) + (await assetCount("room-budget-2")),
    ).toBe(2);

    // The next run picks up the deferred room.
    const second = await createRoomRetentionJob({ maxAssetObjects: 4 }).run(
      deps,
    );
    expect(second).toMatchObject({
      roomsReclaimed: 1,
      enqueuedObjects: 2,
      truncated: false,
    });
  });

  it("stops at the room cap and reports the run as truncated", async () => {
    for (const roomId of ["room-cap-1", "room-cap-2"]) {
      await insertRoom({
        roomId,
        status: "ended",
        expiresAt: new Date(Date.now() - 9 * DAY_MS),
        endedAt: new Date(Date.now() - 8 * DAY_MS),
      });
      await insertSnapshot(roomId);
    }

    const { deps } = makeDeps();
    const first = await createRoomRetentionJob({ maxRooms: 1 }).run(deps);
    expect(first).toMatchObject({ roomsReclaimed: 1, truncated: true });

    // Rerunnable: the next run picks up what the cap left behind.
    const second = await createRoomRetentionJob({ maxRooms: 1 }).run(deps);
    expect(second).toMatchObject({ roomsReclaimed: 1, truncated: false });
    expect(
      (await snapshotCount("room-cap-1")) + (await snapshotCount("room-cap-2")),
    ).toBe(0);
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
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-intruder",
      sceneId: row.id,
      ownerId: "intruder",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await testDb.insert(schema.collaborationAsset).values({
      roomId: "room-intruder",
      authGeneration: 1,
      excalidrawFileId: FILE_B,
      cryptoVersion: 1,
      utFileKey: "room-key-x",
      url: "https://files.example/room-key-x",
      byteLength: 16,
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
        storageObjects: 3,
        status: "dry-run",
      },
    ]);
    expect((await userIds()).sort()).toEqual(["intruder", OWNER]);
    expect(deletedKeys).toEqual([]);
    expect(await testDb.select().from(schema.deferredFileCleanup)).toEqual([]);
  });

  it("deletes non-owner accounts, queues every owned key, and the drain reclaims them", async () => {
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
      enqueuedObjects: 3,
    });
    expect(await userIds()).toEqual([OWNER]);
    // The purge itself touches no storage; the keys wait durably in the queue.
    expect(deletedKeys).toEqual([]);
    const queued = await testDb.select().from(schema.deferredFileCleanup);
    expect(
      queued.map((task) => [task.utFileKey, task.reason, task.status]).sort(),
    ).toEqual([
      ["key-x", "delete-user", "pending"],
      ["room-key-x", "delete-user", "pending"],
      ["thumb-x", "delete-user", "pending"],
    ]);
    // Cascade removed the intruder's scene, records, room, and room assets.
    expect(await testDb.select().from(schema.scene)).toEqual([]);
    expect(await testDb.select().from(schema.fileRecord)).toEqual([]);
    expect(await testDb.select().from(schema.collaborationAsset)).toEqual([]);

    // The drain — ordered after the purge in its run — deletes the objects.
    const drain = await createQueueDrainJob().run(deps);
    expect(drain).toMatchObject({ processed: 3, remaining: 0 });
    expect(deletedKeys.sort()).toEqual(["key-x", "room-key-x", "thumb-x"]);
  });
});
