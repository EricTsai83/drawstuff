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
import { openTestDatabase } from "./support/pglite-db";
import {
  adapterFixture,
  ciphertextChecksum,
  testCiphertext,
} from "./support/authority-adapter-fixtures";

const testDb = openTestDatabase();
const db = testDb as unknown as Database;
describe("PostgreSQL storage adapter", () => {
  it("commits the snapshot and receipt together, replays a lost response and rejects changed metadata", async () => {
    const f = await adapterFixture(db);
    const operation = f.operation();
    expect(
      await executeStorageOperation(db, "write", operation, testCiphertext()),
    ).toEqual({ status: "written", revision: 1 });
    const later = f.operation({ expectedRevision: 1 });
    expect(
      await executeStorageOperation(db, "write", later, testCiphertext()),
    ).toEqual({ status: "written", revision: 2 });
    expect(
      await executeStorageOperation(db, "write", operation, testCiphertext()),
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
        testCiphertext(),
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
      await executeStorageOperation(db, "write", cancelled, testCiphertext()),
    ).toEqual({ status: "cancelled" });
    await testDb
      .delete(schema.collaborationOperation)
      .where(
        eq(schema.collaborationOperation.operationId, cancelled.operationId),
      );
    await applyStorageFence(db, f.fence());
    expect(
      await executeStorageOperation(db, "write", cancelled, testCiphertext()),
    ).toEqual({ status: "refused" });
    const expired = f.operation({
      authorityEpoch: 2,
      deadline: Date.now() - 1,
    });
    expect(
      await executeStorageOperation(db, "write", expired, testCiphertext()),
    ).toEqual({ status: "refused" });
    await testDb
      .delete(schema.collaborationOperation)
      .where(
        eq(schema.collaborationOperation.operationId, expired.operationId),
      );
    expect(
      await executeStorageOperation(db, "write", expired, testCiphertext()),
    ).toEqual({ status: "refused" });
  });
  it("keeps reset revision as a high-water mark instead of reopening revision zero", async () => {
    const f = await adapterFixture(db);
    await executeStorageOperation(db, "write", f.operation(), testCiphertext());
    const reset = f.operation({
      kind: "snapshot-reset",
      expectedRevision: 1,
      checksum: ciphertextChecksum(new Uint8Array()),
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
        testCiphertext(),
      ),
    ).toEqual({ status: "conflict" });
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation({ expectedRevision: 2 }),
        testCiphertext(),
      ),
    ).toEqual({ status: "written", revision: 3 });
  });
  it("rolls back a receipt when the snapshot FK fails, and refuses checksum or envelope mismatch", async () => {
    const f = await adapterFixture(db);
    const wrong = f.operation({
      actor: {
        subject: "missing",
        email: "missing@example.com",
        lifecycleVersion: 1,
      },
    });
    await expect(
      executeStorageOperation(db, "write", wrong, testCiphertext()),
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
        testCiphertext(),
      ),
    ).rejects.toThrow("invalid-body");
    await expect(
      executeStorageOperation(db, "write", f.operation(), new Uint8Array(1)),
    ).rejects.toThrow("invalid-body");
  });
  it("deduplicates finalized assets and queues only unreferenced provider objects", async () => {
    const f = await adapterFixture(db);
    const asset = {
      excalidrawFileId: "file-a",
      cryptoVersion: 1,
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
    await executeStorageOperation(db, "write", snapshot, testCiphertext());
    const command = {
      ...f.fence(1),
      action: "verify-initialization" as const,
      manifest: {
        authGeneration: 1,
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
      cryptoVersion: 1,
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
    await executeStorageOperation(db, "write", operation, testCiphertext());
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
      authGeneration: 1,
      expectedRevision: 0,
      checksum: operation.checksum,
      requestFingerprint: ciphertextChecksum(
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
      testCiphertext(),
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
      await executeStorageOperation(db, "write", pending, testCiphertext()),
    ).toEqual({ status: "cancelled" });
  });
  it("invalidates an initialization check after a newer write and requires a fresh manifest before ready", async () => {
    const f = await adapterFixture(db);
    await testDb
      .update(schema.collaborationRoom)
      .set({ storageState: "initializing" })
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    const first = f.operation();
    await executeStorageOperation(db, "write", first, testCiphertext());
    const command = {
      v: 1 as const,
      roomId: f.roomId,
      authorityEpoch: 1,
      authGeneration: 1,
      action: "verify-initialization" as const,
      manifest: {
        authGeneration: 1,
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
      testCiphertext(),
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
  it("rotates a storage generation under a new fence and retires older ciphertext without losing receipts", async () => {
    const f = await adapterFixture(db);
    const old = f.operation();
    await executeStorageOperation(db, "write", old, testCiphertext());
    await expect(
      applyStorageFence(
        db,
        f.fence(2, { authGeneration: 2, state: "initializing" }),
      ),
    ).rejects.toThrow("fence-mismatch");
    await applyStorageFence(
      db,
      f.fence(2, {
        authGeneration: 2,
        state: "initializing",
        initializationDeadline:
          Date.now() + AUTHORITY_LIMITS.initializationTtlMs,
      }),
    );
    await expect(readAdapterSnapshot(db, old)).rejects.toThrow(
      "fence-mismatch",
    );
    expect(await executeStorageOperation(db, "query", old)).toEqual({
      status: "written",
      revision: 1,
    });
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation({ authorityEpoch: 2, authGeneration: 2 }),
        testCiphertext(),
      ),
    ).toEqual({ status: "written", revision: 1 });
    expect(
      await testDb
        .select()
        .from(schema.collaborationSnapshot)
        .where(eq(schema.collaborationSnapshot.roomId, f.roomId)),
    ).toHaveLength(1);
  });
});
