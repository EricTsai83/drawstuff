// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/collab/lifecycle-gateway", () => ({
  callLifecycleGateway: () => Promise.reject(new Error("unexpected")),
}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: () => Promise.resolve(),
  rateLimitMetadataOf: () => null,
}));
const { envDouble, storage } = vi.hoisted(() => ({
  envDouble: {
    COLLAB_CONTROL_URL: "http://127.0.0.1:3105",
  },
  storage: {
    files: [] as {
      key: string;
      size: number;
      status: string;
      uploadedAt: number;
    }[],
    deleted: [] as string[],
  },
}));
vi.mock("@/env", () => ({ env: envDouble }));
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    getUsageInfo() {
      return Promise.resolve({
        totalBytes: 10,
        appTotalBytes: 10,
        filesUploaded: 1,
        limitBytes: 2 * 1024 ** 3,
      });
    }
    listFiles({ limit, offset }: { limit: number; offset: number }) {
      return Promise.resolve({
        files: storage.files.slice(offset, offset + limit),
        hasMore: offset + limit < storage.files.length,
      });
    }
    deleteFiles(keys: string[]) {
      storage.deleted.push(...keys);
      return Promise.resolve({ success: true });
    }
  },
}));

const { pgClient, testDb } = await vi.hoisted(async () => {
  const { createTestDatabase } = await import("../support/pglite-db");
  return createTestDatabase();
});
vi.mock("@/server/db/index", () => ({ db: testDb }));

import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { DATA_RELEASE_CATALOG } from "@/server/admin/data-release";
import * as schema from "@/server/db/schema";
import { createQueueDrainJob } from "@/server/maintenance/jobs";
import { scanStorageOrphans } from "@/server/storage/orphans";
import type { Database } from "@/server/collab/rooms";
import { registerTestDatabase } from "../support/pglite-db";
import { testCaller } from "../support/trpc-caller";

registerTestDatabase({ pgClient, testDb });

const DAY_MS = 24 * 60 * 60_000;
const admin = () => testCaller(testDb, "admin-user").admin;
const old = Date.now() - 8 * DAY_MS;

beforeEach(async () => {
  storage.files = [];
  storage.deleted = [];
  await testDb.delete(schema.adminAuditEvent);
  await testDb.delete(schema.maintenanceRun);
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.adminGrant);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: "admin-user", name: "Admin", email: "admin@example.com" },
    { id: "owner", name: "Owner", email: "owner@example.com" },
  ]);
  await testDb.insert(schema.adminGrant).values({
    userId: "admin-user",
    role: "operator",
    grantSource: "bootstrap",
  });
});

describe("data release map", () => {
  it("gives every schema table exactly one release path", () => {
    const tables = Object.values(schema).filter((value) => is(value, PgTable));
    const cataloged = DATA_RELEASE_CATALOG.flatMap((entry) => entry.tables);
    expect(new Set(cataloged).size).toBe(cataloged.length);
    expect(new Set(cataloged)).toEqual(new Set(tables));
  });

  it("reports sizes, storage usage, and each job's last outcome", async () => {
    await testDb.insert(schema.maintenanceRun).values({
      trigger: "cron",
      status: "failed",
      failedJobs: 1,
      startedAt: new Date(),
      report: JSON.stringify({
        failed: 1,
        jobs: [
          { name: "record-retention", status: "error", error: "boom" },
          { name: "drain-cleanup-queue", status: "ok", detail: {} },
        ],
      }),
    });
    // A newer manual retention audit must not hide the real outcomes.
    await testDb.insert(schema.maintenanceRun).values({
      trigger: "manual",
      status: "succeeded",
      startedAt: new Date(Date.now() + 1_000),
      report: JSON.stringify({
        failed: 0,
        jobs: [
          {
            name: "record-retention",
            status: "ok",
            detail: { dryRun: true },
          },
        ],
      }),
    });
    const release = await admin().dataRelease();
    expect(release.databaseBytes).toBeGreaterThan(0);
    expect(release.uploadthing).toMatchObject({ available: true, files: 1 });
    const accounts = release.entries.find((entry) => entry.key === "accounts");
    expect(accounts).toMatchObject({ rows: expect.any(Number) as number });
    expect(accounts!.rows).toBeGreaterThanOrEqual(3);
    const audit = release.entries.find((entry) => entry.key === "auditLog");
    expect(audit?.jobs).toEqual([
      { name: "record-retention", status: "error", error: "boom" },
    ]);
    // Neon relation size and recorded object payload are reported apart.
    const images = release.entries.find((entry) => entry.key === "sceneImages");
    expect(images).toMatchObject({ objectBytes: 0 });
    expect(images!.databaseBytes).toBeGreaterThan(0);
    const scenes = release.entries.find((entry) => entry.key === "scenes");
    expect(scenes?.release).toEqual({ mode: "manual", place: "user-page" });
  });
});

describe("storage orphan reconciliation", () => {
  it("finds only old, uploaded objects nothing points at", async () => {
    const [ownedScene] = await testDb
      .insert(schema.scene)
      .values({ userId: "owner", name: "S", thumbnailFileKey: "thumb" })
      .returning({ id: schema.scene.id });
    await testDb.insert(schema.fileRecord).values({
      sceneId: ownedScene!.id,
      ownerId: "owner",
      utFileKey: "image",
      excalidrawFileId: "file-1",
      size: 1,
      url: "https://example.com/image",
    });
    await testDb
      .insert(schema.deferredFileCleanup)
      .values({ utFileKey: "queued", reason: "t" });
    storage.files = [
      { key: "image", size: 1, status: "Uploaded", uploadedAt: old },
      { key: "thumb", size: 1, status: "Uploaded", uploadedAt: old },
      { key: "queued", size: 1, status: "Uploaded", uploadedAt: old },
      // Inside the 7-day grace: its callback may not have written its row yet.
      {
        key: "fresh",
        size: 1,
        status: "Uploaded",
        uploadedAt: Date.now() - 6 * DAY_MS,
      },
      { key: "uploading", size: 1, status: "Uploading", uploadedAt: old },
      { key: "orphan", size: 7, status: "Uploaded", uploadedAt: old },
    ];
    const scan = await admin().scanStorageOrphans({ offset: 0 });
    expect(scan).toMatchObject({
      scanned: 6,
      nextOffset: null,
      orphans: 1,
      orphanBytes: 7,
    });
    expect(scan.sample.map((file) => file.key)).toEqual(["orphan"]);
  });

  it("pages through storage and reports a truncated scan", async () => {
    storage.files = Array.from({ length: 10_001 }, (_, i) => ({
      key: `k-${i}`,
      size: 1,
      status: "Uploading",
      uploadedAt: old,
    }));
    const scan = await scanStorageOrphans(testDb as unknown as Database, {
      listFiles: ({ limit, offset }) =>
        Promise.resolve({
          files: storage.files.slice(offset, offset + limit),
          hasMore: offset + limit < storage.files.length,
        }),
    });
    expect(scan).toMatchObject({ scanned: 10_000, nextOffset: 10_000 });
    // The next segment continues where this one stopped.
    const next = await scanStorageOrphans(
      testDb as unknown as Database,
      {
        listFiles: ({ limit, offset }) =>
          Promise.resolve({
            files: storage.files.slice(offset, offset + limit),
            hasMore: offset + limit < storage.files.length,
          }),
      },
      10_000,
    );
    expect(next).toMatchObject({
      offset: 10_000,
      scanned: 1,
      nextOffset: null,
    });
  });

  it("queues orphans and the drain re-checks each before deleting", async () => {
    storage.files = [
      { key: "orphan-a", size: 1, status: "Uploaded", uploadedAt: old },
      { key: "orphan-b", size: 1, status: "Uploaded", uploadedAt: old },
      { key: "orphan-c", size: 1, status: "Uploaded", uploadedAt: old },
      { key: "orphan-d", size: 1, status: "Uploaded", uploadedAt: old },
    ];
    await expect(
      admin().enqueueStorageOrphans({ offset: 0 }),
    ).resolves.toMatchObject({ enqueued: 4 });
    // Between the scan and the drain: orphan-b gains a pointer, orphan-c a
    // published-artifact reservation that may still be claimed, and orphan-d
    // an unrelated second deletion (which is not a reference).
    const [ownedScene] = await testDb
      .insert(schema.scene)
      .values({ userId: "owner", name: "S", thumbnailFileKey: "orphan-b" })
      .returning({ id: schema.scene.id });
    expect(ownedScene).toBeDefined();
    await testDb.insert(schema.deferredFileCleanup).values([
      {
        utFileKey: "orphan-c",
        reason: "published-artifact-unclaimed",
        nextAttemptAt: new Date(Date.now() + DAY_MS),
      },
      { utFileKey: "orphan-d", reason: "delete-scene" },
    ]);

    const detail = await createQueueDrainJob().run({
      deleteStorageFile: (key) => {
        storage.deleted.push(key);
        return Promise.resolve();
      },
      now: () => new Date(),
    });
    expect(storage.deleted.sort()).toEqual([
      "orphan-a",
      "orphan-d",
      "orphan-d",
    ]);
    expect(detail).toMatchObject({ processed: 3, stillReferenced: 2 });
    const [audit] = await testDb.select().from(schema.adminAuditEvent);
    expect(audit).toMatchObject({
      action: "enqueue-storage-orphans",
      status: "succeeded",
    });
  });
});
