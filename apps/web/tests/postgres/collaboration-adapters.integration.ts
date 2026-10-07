import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  generateDrizzleJson,
  generateMigration,
  type DrizzleSnapshotJSON,
} from "drizzle-kit/api";
import { eq } from "drizzle-orm";
vi.mock("server-only", () => ({}));
import * as schema from "@/server/db/schema";
import {
  applyStorageFence,
  executeStorageOperation,
  readAdapterSnapshot,
} from "@/server/collab/authority-storage";
import {
  applyRoomProjection,
  listProjectedRooms,
} from "@/server/collab/authority-projection";
import { lockRoom } from "@/server/collab/rooms";
import {
  adapterFixture,
  testCiphertext,
} from "../support/authority-adapter-fixtures";

const url = process.env.COLLAB_ADAPTER_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/drawstuff_adapters"
)
  throw new Error("Run pnpm collab:adapters with its disposable local fixture");
const client = postgres(url, {
  max: 8,
  connection: { application_name: "drawstuff-adapters" },
});
const db = drizzle(client, { schema });
beforeAll(async () => {
  // pushSchema introspection expects a { rows } executor; postgres-js returns an array.
  // Apply DDL generated from the exact production schema to this wrapper-created empty DB.
  // Kit 0.31's snapshot declaration uses the removed Zod TypeOf export; isolate that broken type.
  const empty: unknown = generateDrizzleJson({});
  const current: unknown = generateDrizzleJson(schema);
  const statements = await generateMigration(
    empty as DrizzleSnapshotJSON,
    current as DrizzleSnapshotJSON,
  );
  for (const statement of statements) await client.unsafe(statement);
});
afterAll(() => client.end());

function gate() {
  let release = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function waitForBlocked(count: number) {
  await vi.waitFor(
    async () => {
      const [row] = await client<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='drawstuff-adapters' AND wait_event_type='Lock'`;
      expect(row?.count).toBeGreaterThanOrEqual(count);
    },
    { timeout: 5_000, interval: 10 },
  );
}
async function holdRoom(roomId: string) {
  const reached = gate();
  const unblock = gate();
  const finished = db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    reached.release();
    await unblock.wait;
  });
  await reached.wait;
  return { release: unblock.release, finished };
}

describe("actual PostgreSQL adapter lock races", () => {
  it("waits for accepted writes before confirming a fence and refuses every late old-epoch write", async () => {
    const f = await adapterFixture(db);
    const held = await holdRoom(f.roomId);
    const operation = f.operation();
    const write = executeStorageOperation(
      db,
      "write",
      operation,
      testCiphertext(),
    );
    await waitForBlocked(1);
    let fenceFinished = false;
    const fence = applyStorageFence(db, f.fence()).then((result) => {
      fenceFinished = true;
      return result;
    });
    try {
      await waitForBlocked(2);
      expect(fenceFinished).toBe(false);
    } finally {
      held.release();
    }
    await held.finished;
    await fence;
    const before = await readAdapterSnapshot(db, f.fence());
    const result = await write;
    expect(["written", "refused"]).toContain(result.status);
    const after = await readAdapterSnapshot(db, f.fence());
    expect(after?.revision).toBe(before?.revision);
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation(),
        testCiphertext(),
      ),
    ).toEqual({ status: "refused" });
    expect(await executeStorageOperation(db, "query", operation)).toEqual(
      result,
    );
  });
  it("returns one durable result when cancellation races a write, so no cancelled payload can land afterwards", async () => {
    const f = await adapterFixture(db);
    const held = await holdRoom(f.roomId);
    const operation = f.operation();
    const cancel = executeStorageOperation(db, "cancel", operation);
    await waitForBlocked(1);
    const write = executeStorageOperation(
      db,
      "write",
      operation,
      testCiphertext(),
    );
    try {
      await waitForBlocked(2);
    } finally {
      held.release();
    }
    await held.finished;
    const [cancelled, written] = await Promise.all([cancel, write]);
    expect(cancelled).toEqual(written);
    expect(
      await executeStorageOperation(db, "write", operation, testCiphertext()),
    ).toEqual(cancelled);
    if (cancelled.status === "cancelled")
      expect(await readAdapterSnapshot(db, operation)).toBeNull();
    else expect(cancelled).toEqual({ status: "written", revision: 1 });
  });
  it("serializes concurrent optimistic writes, and response recovery does not overwrite the newer snapshot", async () => {
    const f = await adapterFixture(db);
    const first = f.operation();
    const second = f.operation();
    const results = await Promise.all([
      executeStorageOperation(db, "write", first, testCiphertext()),
      executeStorageOperation(db, "write", second, testCiphertext()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "conflict",
      "written",
    ]);
    const winner = results[0]?.status === "written" ? first : second;
    await executeStorageOperation(
      db,
      "write",
      f.operation({ expectedRevision: 1 }),
      testCiphertext(),
    );
    expect(
      await executeStorageOperation(db, "write", winner, testCiphertext()),
    ).toEqual({ status: "written", revision: 1 });
    expect((await readAdapterSnapshot(db, winner))?.revision).toBe(2);
  });
  it("binds global operation identity even when the same UUID is submitted to different locked rooms", async () => {
    const a = await adapterFixture(db);
    const b = await adapterFixture(db);
    const operationId = crypto.randomUUID();
    const results = await Promise.allSettled([
      executeStorageOperation(
        db,
        "write",
        a.operation({ operationId }),
        testCiphertext(),
      ),
      executeStorageOperation(
        db,
        "write",
        b.operation({ operationId }),
        testCiphertext(),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser).toMatchObject({
      status: "rejected",
      reason: { message: "operation-mismatch" },
    });
    const [receipt] = await db
      .select()
      .from(schema.collaborationOperation)
      .where(eq(schema.collaborationOperation.operationId, operationId));
    expect(receipt?.status).toBe("written");
  });
  it("protects a provider key from simultaneous reference and orphan cleanup across rooms", async () => {
    const a = await adapterFixture(db);
    const b = await adapterFixture(db);
    const asset = {
      excalidrawFileId: "file-shared-key",
      cryptoVersion: 1,
      byteLength: 32,
      url: "https://files.example/key",
      utFileKey: `shared-${crypto.randomUUID()}`,
    };
    const results = await Promise.all([
      executeStorageOperation(
        db,
        "write",
        a.operation({ kind: "asset-finalize", asset }),
      ),
      executeStorageOperation(
        db,
        "write",
        b.operation({ kind: "asset-finalize", asset }),
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "refused",
      "written",
    ]);
    expect(
      await db
        .select()
        .from(schema.deferredFileCleanup)
        .where(eq(schema.deferredFileCleanup.utFileKey, asset.utFileKey)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.utFileKey, asset.utFileKey)),
    ).toHaveLength(1);
  });
  it("orders concurrent projections and a parent deletion without resurrecting membership", async () => {
    const f = await adapterFixture(db);
    await Promise.all([
      applyRoomProjection(db, f.projection({ version: 2 })),
      applyRoomProjection(db, f.projection({ version: 4, tombstone: true })),
      applyRoomProjection(db, f.projection({ version: 3, role: "viewer" })),
    ]);
    expect((await listProjectedRooms(db, f.guest)).rooms).toEqual([]);
    expect(await applyRoomProjection(db, f.projection({ version: 3 }))).toEqual(
      { applied: false },
    );
    await Promise.all([
      applyRoomProjection(db, f.projection({ version: 5 })),
      db.delete(schema.user).where(eq(schema.user.id, f.guest)),
    ]);
    expect((await listProjectedRooms(db, f.guest)).rooms).toEqual([]);
    expect(await applyRoomProjection(db, f.projection({ version: 6 }))).toEqual(
      { applied: false },
    );
  });
});
