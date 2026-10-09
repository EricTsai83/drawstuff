import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("server-only", () => ({}));
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/collab/rooms";
import {
  applyStorageFence,
  cleanupAdapterRoom,
  executeStorageOperation,
  readAdapterSnapshot,
  verifyAdapterInitialization,
} from "@/server/collab/authority-storage";
import {
  AUTHORITY_LIMITS,
  contentOperationSchema,
} from "@drawstuff/collaboration/authority";
import { MAX_SNAPSHOT_BYTES } from "@drawstuff/collaboration/snapshot";
import { openTestDatabase } from "./support/pglite-db";
import {
  adapterFixture,
  bytesChecksum,
  testSnapshotBytes,
} from "./support/authority-adapter-fixtures";

const testDb = openTestDatabase();
const db = testDb as unknown as Database;
describe("PostgreSQL storage adapter", () => {
  it("stores the snapshot's plain bytes as written", async () => {
    const f = await adapterFixture(db);
    const bytes = new TextEncoder().encode('{"elements":[]}');
    const operation = f.operation({}, bytes);
    expect(
      await executeStorageOperation(db, "write", operation, bytes),
    ).toEqual({ status: "written", revision: 1 });
    expect(await readAdapterSnapshot(db, operation)).toMatchObject({
      roomId: f.roomId,
      revision: 1,
      data: bytes,
      byteLength: bytes.byteLength,
      checksum: bytesChecksum(bytes),
      updatedBy: f.owner,
    });
  });
  it("commits the snapshot and receipt together, replays a lost response and rejects changed metadata", async () => {
    const f = await adapterFixture(db);
    const operation = f.operation();
    expect(
      await executeStorageOperation(
        db,
        "write",
        operation,
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "written", revision: 1 });
    const later = f.operation({ expectedRevision: 1 });
    expect(
      await executeStorageOperation(db, "write", later, testSnapshotBytes()),
    ).toEqual({ status: "written", revision: 2 });
    expect(
      await executeStorageOperation(
        db,
        "write",
        operation,
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "written", revision: 1 });
    expect(await executeStorageOperation(db, "query", operation)).toEqual({
      status: "written",
      revision: 1,
    });
    await expect(
      executeStorageOperation(db, "query", {
        ...operation,
        deadline: operation.deadline + 1,
      }),
    ).rejects.toThrow("operation-mismatch");
    expect((await readAdapterSnapshot(db, operation))?.revision).toBe(2);
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation(),
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "conflict" });
  });
  it("orders cancellation against late writes and retains epoch rejection after receipt pruning", async () => {
    const f = await adapterFixture(db);
    const cancelled = f.operation();
    expect(await executeStorageOperation(db, "cancel", cancelled)).toEqual({
      status: "cancelled",
    });
    expect(
      await executeStorageOperation(
        db,
        "write",
        cancelled,
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "cancelled" });
    await testDb
      .delete(schema.collaborationOperation)
      .where(
        eq(schema.collaborationOperation.operationId, cancelled.operationId),
      );
    await applyStorageFence(db, f.fence());
    expect(
      await executeStorageOperation(
        db,
        "write",
        cancelled,
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "refused" });
    const expired = f.operation({
      authorityEpoch: 2,
      deadline: Date.now() - 1,
    });
    expect(
      await executeStorageOperation(db, "write", expired, testSnapshotBytes()),
    ).toEqual({ status: "refused" });
    await testDb
      .delete(schema.collaborationOperation)
      .where(
        eq(schema.collaborationOperation.operationId, expired.operationId),
      );
    expect(
      await executeStorageOperation(db, "write", expired, testSnapshotBytes()),
    ).toEqual({ status: "refused" });
  });
  it("keeps reset revision as a high-water mark instead of reopening revision zero", async () => {
    const f = await adapterFixture(db);
    await executeStorageOperation(
      db,
      "write",
      f.operation(),
      testSnapshotBytes(),
    );
    const reset = f.operation({
      kind: "snapshot-reset",
      expectedRevision: 1,
      checksum: bytesChecksum(new Uint8Array()),
    });
    expect(await executeStorageOperation(db, "write", reset)).toEqual({
      status: "written",
      revision: 2,
    });
    expect(await readAdapterSnapshot(db, reset)).toBeNull();
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation(),
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "conflict" });
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation({ expectedRevision: 2 }),
        testSnapshotBytes(),
      ),
    ).toEqual({ status: "written", revision: 3 });
  });
  it("rolls back a receipt when the snapshot FK fails, and refuses a bad checksum, an empty body or an oversized body", async () => {
    const f = await adapterFixture(db);
    const wrong = f.operation({
      actor: {
        subject: "missing",
        email: "missing@example.com",
        lifecycleVersion: 1,
      },
    });
    await expect(
      executeStorageOperation(db, "write", wrong, testSnapshotBytes()),
    ).rejects.toThrow();
    expect(
      await testDb.query.collaborationOperation.findFirst({
        where: eq(schema.collaborationOperation.operationId, wrong.operationId),
      }),
    ).toBeUndefined();
    await expect(
      executeStorageOperation(
        db,
        "write",
        f.operation({ checksum: "0".repeat(64) }),
        testSnapshotBytes(),
      ),
    ).rejects.toThrow("invalid-body");
    const empty = new Uint8Array();
    await expect(
      executeStorageOperation(db, "write", f.operation({}, empty), empty),
    ).rejects.toThrow("invalid-body");
    await expect(
      executeStorageOperation(db, "write", f.operation()),
    ).rejects.toThrow("invalid-body");
    const oversized = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
    await expect(
      executeStorageOperation(
        db,
        "write",
        f.operation({}, oversized),
        oversized,
      ),
    ).rejects.toThrow("body-too-large");
    expect(await readAdapterSnapshot(db, f.operation())).toBeNull();
  });
  it("deduplicates finalized assets and queues only unreferenced provider objects", async () => {
    const f = await adapterFixture(db);
    const asset = {
      excalidrawFileId: "file-a",
      byteLength: 32,
      url: "https://files.example/a",
      utFileKey: `key-${crypto.randomUUID()}`,
    };
    const operation = f.operation({ kind: "asset-finalize", asset });
    expect(await executeStorageOperation(db, "write", operation)).toEqual({
      status: "written",
      revision: 1,
    });
    await expect(
      executeStorageOperation(db, "query", {
        ...operation,
        asset: { ...asset, byteLength: 33 },
      }),
    ).rejects.toThrow("operation-mismatch");
    const duplicate = f.operation({
      kind: "asset-finalize",
      asset: { ...asset, utFileKey: `other-${crypto.randomUUID()}` },
    });
    expect((await executeStorageOperation(db, "write", duplicate)).status).toBe(
      "written",
    );
    expect(
      await testDb.query.deferredFileCleanup.findFirst({
        where: eq(
          schema.deferredFileCleanup.utFileKey,
          duplicate.asset!.utFileKey,
        ),
      }),
    ).toBeDefined();
    expect(
      await testDb.query.deferredFileCleanup.findFirst({
        where: eq(schema.deferredFileCleanup.utFileKey, asset.utFileKey),
      }),
    ).toBeUndefined();
    await applyStorageFence(db, f.fence(2, { state: "ended" }));
    await cleanupAdapterRoom(db, { ...f.fence(), action: "cleanup" });
    await cleanupAdapterRoom(db, { ...f.fence(), action: "cleanup" });
    const cleaned = await testDb
      .select()
      .from(schema.deferredFileCleanup)
      .where(eq(schema.deferredFileCleanup.utFileKey, asset.utFileKey));
    expect(cleaned).toHaveLength(1);
    expect(
      await testDb.query.collaborationOperation.findFirst({
        where: eq(
          schema.collaborationOperation.operationId,
          operation.operationId,
        ),
      }),
    ).toBeDefined();
  });
  it("verifies the latest declared snapshot and every finalized asset, rejects late completion after fencing", async () => {
    const f = await adapterFixture(db);
    await testDb
      .update(schema.collaborationRoom)
      .set({ storageState: "initializing" })
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    const snapshot = f.operation();
    await executeStorageOperation(db, "write", snapshot, testSnapshotBytes());
    const command = {
      ...f.fence(1),
      action: "verify-initialization" as const,
      manifest: {
        revision: 1,
        checksum: snapshot.checksum,
        assetIds: ["file-a"],
      },
    };
    await expect(verifyAdapterInitialization(db, command)).rejects.toThrow(
      "initialization-incomplete",
    );
    const asset = {
      excalidrawFileId: "file-a",
      byteLength: 32,
      url: "https://files.example/a",
      utFileKey: `init-${crypto.randomUUID()}`,
    };
    await executeStorageOperation(
      db,
      "write",
      f.operation({ kind: "asset-finalize", asset }),
    );
    expect(await verifyAdapterInitialization(db, command)).toEqual({
      manifest: command.manifest,
    });
    await applyStorageFence(db, f.fence(2, { state: "ended" }));
    await expect(verifyAdapterInitialization(db, command)).rejects.toThrow(
      "initialization-incomplete",
    );
    await expect(applyStorageFence(db, f.fence(3))).rejects.toThrow(
      "fence-mismatch",
    );
  });
  it("prunes terminal receipts in bounded batches and never expires pending results", async () => {
    const f = await adapterFixture(db);
    const operation = f.operation();
    await executeStorageOperation(db, "write", operation, testSnapshotBytes());
    await testDb
      .update(schema.collaborationOperation)
      .set({
        terminalAt: new Date(
          Date.now() - AUTHORITY_LIMITS.resultRetentionMs - 1,
        ),
      })
      .where(
        eq(schema.collaborationOperation.operationId, operation.operationId),
      );
    const pending = f.operation({ deadline: Date.now() - 1 });
    const pendingId = pending.operationId;
    await testDb.insert(schema.collaborationOperation).values({
      operationId: pendingId,
      roomId: f.roomId,
      actor: f.owner,
      kind: "snapshot-put",
      authorityEpoch: 1,
      expectedRevision: 0,
      checksum: operation.checksum,
      requestFingerprint: bytesChecksum(
        new TextEncoder().encode(
          JSON.stringify(contentOperationSchema.parse(pending)),
        ),
      ),
      deadline: new Date(pending.deadline),
      status: "pending",
    });
    await executeStorageOperation(
      db,
      "write",
      f.operation({ expectedRevision: 1 }),
      testSnapshotBytes(),
    );
    expect(
      await testDb.query.collaborationOperation.findFirst({
        where: eq(
          schema.collaborationOperation.operationId,
          operation.operationId,
        ),
      }),
    ).toBeUndefined();
    expect(
      await testDb.query.collaborationOperation.findFirst({
        where: eq(schema.collaborationOperation.operationId, pendingId),
      }),
    ).toMatchObject({ status: "pending", terminalAt: null });
    expect(await executeStorageOperation(db, "cancel", pending)).toEqual({
      status: "cancelled",
    });
    expect(
      await executeStorageOperation(db, "write", pending, testSnapshotBytes()),
    ).toEqual({ status: "cancelled" });
  });
  it("invalidates an initialization check after a newer write and requires a fresh manifest before ready", async () => {
    const f = await adapterFixture(db);
    await testDb
      .update(schema.collaborationRoom)
      .set({ storageState: "initializing" })
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    const first = f.operation();
    await executeStorageOperation(db, "write", first, testSnapshotBytes());
    const command = {
      v: 1 as const,
      roomId: f.roomId,
      authorityEpoch: 1,
      action: "verify-initialization" as const,
      manifest: {
        revision: 1,
        checksum: first.checksum,
        assetIds: [],
      },
    };
    await verifyAdapterInitialization(db, command);
    await executeStorageOperation(
      db,
      "write",
      f.operation({ expectedRevision: 1 }),
      testSnapshotBytes(),
    );
    await expect(applyStorageFence(db, f.fence(1))).rejects.toThrow(
      "initialization-incomplete",
    );
    await verifyAdapterInitialization(db, {
      ...command,
      manifest: { ...command.manifest, revision: 2 },
    });
    await applyStorageFence(db, f.fence(1));
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ storageState: "ready" });
  });
  it("stamps endedAt on the first terminal fence and keeps it on later ones", async () => {
    const f = await adapterFixture(db);
    const room = async () =>
      testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      });
    expect((await room())?.endedAt).toBeNull();
    await applyStorageFence(db, f.fence(2, { state: "ended" }));
    const endedAt = (await room())?.endedAt;
    expect(endedAt).toBeInstanceOf(Date);
    await applyStorageFence(db, f.fence(3, { state: "ended" }));
    expect((await room())?.endedAt).toEqual(endedAt);
  });
  it("advances the epoch without rotating storage: snapshot and assets survive, ready never reopens, ended stays ended", async () => {
    const f = await adapterFixture(db);
    const old = f.operation();
    await executeStorageOperation(db, "write", old, testSnapshotBytes());
    const asset = {
      excalidrawFileId: "kept-file",
      byteLength: 32,
      url: "https://files.example/kept",
      utFileKey: `kept-${crypto.randomUUID()}`,
    };
    await executeStorageOperation(
      db,
      "write",
      f.operation({ kind: "asset-finalize", asset }),
    );
    expect(
      await applyStorageFence(db, f.fence(2, { state: "initializing" })),
    ).toEqual({ authorityEpoch: 2 });
    await expect(readAdapterSnapshot(db, old)).rejects.toThrow(
      "fence-mismatch",
    );
    const current = f.operation({ authorityEpoch: 2, expectedRevision: 1 });
    expect((await readAdapterSnapshot(db, current))?.revision).toBe(1);
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ authorityEpoch: 2, storageState: "ready" });
    expect(
      await testDb
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.roomId, f.roomId)),
    ).toHaveLength(1);
    expect(
      await executeStorageOperation(db, "write", current, testSnapshotBytes()),
    ).toEqual({ status: "written", revision: 2 });
    expect(await executeStorageOperation(db, "query", old)).toEqual({
      status: "written",
      revision: 1,
    });
    await applyStorageFence(db, f.fence(3, { state: "ended" }));
    await expect(applyStorageFence(db, f.fence(4))).rejects.toThrow(
      "fence-mismatch",
    );
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ authorityEpoch: 3, storageState: "ended" });
  });
});
