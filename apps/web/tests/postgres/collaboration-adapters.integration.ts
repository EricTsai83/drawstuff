import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  generateDrizzleJson,
  generateMigration,
  type DrizzleSnapshotJSON,
} from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import {
  registerAuthorityCommand,
  createAuthorityParent,
} from "@/server/collab/authority-registration";
vi.mock("server-only", () => ({}));
import * as schema from "@/server/db/schema";
import {
  applyStorageFence,
  executeStorageOperation,
  readAdapterSnapshot,
  readAdapterSnapshotState,
  queueAuthorityAssetOrphan,
} from "@/server/collab/authority-storage";
import {
  applyRoomProjection,
  listProjectedRooms,
} from "@/server/collab/authority-projection";
import {
  applyLifecycleAdapter,
  retirementIntent,
} from "@/server/collab/authority-lifecycle";
import {
  collaborationDDL,
  resetDDL,
} from "../../scripts/collaboration-reset-ddl";
import {
  inspectResetDatabase,
  compareResetReports,
} from "../../scripts/collaboration-reset-inspect";
import * as legacy from "../support/legacy-collaboration-schema";
import { lockRoom } from "@/server/collab/rooms";
import {
  adapterFixture,
  testCiphertext,
  ciphertextChecksum,
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
  it("orders an absent-snapshot read after reset under the room lock and preserves its revision", async () => {
    const f = await adapterFixture(db);
    await executeStorageOperation(db, "write", f.operation(), testCiphertext());
    const held = await holdRoom(f.roomId);
    const reset = f.operation({
      kind: "snapshot-reset",
      expectedRevision: 1,
      checksum: ciphertextChecksum(new Uint8Array()),
    });
    const resetting = executeStorageOperation(db, "write", reset);
    let reading: ReturnType<typeof readAdapterSnapshotState> | undefined;
    try {
      await waitForBlocked(1);
      reading = readAdapterSnapshotState(db, reset);
      await waitForBlocked(2);
    } finally {
      held.release();
    }
    await held.finished;
    expect(await resetting).toEqual({ status: "written", revision: 2 });
    const state = await reading;
    expect(state).toEqual({ snapshot: null, revision: 2 });
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation({ expectedRevision: state.revision }),
        testCiphertext(),
      ),
    ).toEqual({ status: "written", revision: 3 });
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
  it("queues an unknown callback before a blocked write and refuses later object adoption", async () => {
    const f = await adapterFixture(db);
    const asset = {
      excalidrawFileId: "callback-orphan",
      utFileKey: `orphan-${crypto.randomUUID()}`,
      cryptoVersion: 1,
      byteLength: 32,
      url: "https://storage.test/ciphertext",
    };
    const held = await holdRoom(f.roomId);
    const write = executeStorageOperation(
      db,
      "write",
      f.operation({ kind: "asset-finalize", asset }),
    );
    try {
      await waitForBlocked(1);
      await queueAuthorityAssetOrphan(db, asset.utFileKey, f.roomId);
    } finally {
      held.release();
      await held.finished;
    }
    expect(await write).toEqual({ status: "refused" });
    expect(
      await db
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.utFileKey, asset.utFileKey)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.deferredFileCleanup)
        .where(eq(schema.deferredFileCleanup.utFileKey, asset.utFileKey)),
    ).toHaveLength(1);
  });

  it("lets a waiting write win the object lock and keeps unknown callback cleanup from deleting its live reference", async () => {
    const f = await adapterFixture(db);
    const asset = {
      excalidrawFileId: "callback-committed",
      utFileKey: `committed-${crypto.randomUUID()}`,
      cryptoVersion: 1,
      byteLength: 32,
      url: "https://storage.test/ciphertext",
    };
    const reached = gate(),
      unblock = gate();
    const held = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${"drawstuff:collab-asset:" + asset.utFileKey},0))`,
      );
      reached.release();
      await unblock.wait;
    });
    await reached.wait;
    const write = executeStorageOperation(
      db,
      "write",
      f.operation({ kind: "asset-finalize", asset }),
    );
    let cleanup: Promise<void> | undefined;
    try {
      await waitForBlocked(1);
      cleanup = queueAuthorityAssetOrphan(db, asset.utFileKey, f.roomId);
      await waitForBlocked(2);
    } finally {
      unblock.release();
      await held;
    }
    expect(await write).toEqual({ status: "written", revision: 1 });
    await cleanup;
    expect(
      await db
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.utFileKey, asset.utFileKey)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.deferredFileCleanup)
        .where(eq(schema.deferredFileCleanup.utFileKey, asset.utFileKey)),
    ).toHaveLength(0);
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
  it("orders registration against account freeze under the same lifecycle row lock", async () => {
    const f = await adapterFixture(db);
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, f.owner));
    const scope = `account:${f.owner}`;
    await db
      .insert(schema.collaborationLifecycleSubject)
      .values({ scope, subject: f.owner, kind: "account" });
    const reached = gate();
    const unblock = gate();
    const freezing = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.collaborationLifecycleSubject)
        .where(eq(schema.collaborationLifecycleSubject.scope, scope))
        .for("update");
      reached.release();
      await unblock.wait;
      await tx
        .update(schema.collaborationLifecycleSubject)
        .set({ frozen: true, version: 2 })
        .where(eq(schema.collaborationLifecycleSubject.scope, scope));
    });
    await reached.wait;
    const registration = registerAuthorityCommand(db, {
      v: 1,
      action: "register",
      roomId: f.roomId,
      operationId: crypto.randomUUID(),
      identity: f.operation().actor,
      ownerId: f.owner,
      sceneId: null,
      create: true,
    });
    const outcome = registration.then(
      () => "accepted",
      () => "refused",
    );
    try {
      await waitForBlocked(1);
    } finally {
      unblock.release();
    }
    await freezing;
    expect(await outcome).toBe("refused");
    expect(
      await db
        .select()
        .from(schema.collaborationLifecycleRegistration)
        .where(
          and(
            eq(schema.collaborationLifecycleRegistration.subject, f.owner),
            eq(schema.collaborationLifecycleRegistration.roomId, f.roomId),
          ),
        ),
    ).toHaveLength(0);
  });

  it("a missing-parent terminal fence orders against delayed parent creation", async () => {
    const f = await adapterFixture(db);
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, f.owner));
    await db
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    const operationId = crypto.randomUUID();
    await registerAuthorityCommand(db, {
      v: 1,
      action: "register",
      roomId: f.roomId,
      operationId,
      identity: f.operation().actor,
      ownerId: f.owner,
      sceneId: null,
      create: true,
    });
    await db
      .insert(schema.collaborationCreationFence)
      .values({ roomId: f.roomId });
    const reached = gate();
    const unblock = gate();
    const holding = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.collaborationCreationFence)
        .where(eq(schema.collaborationCreationFence.roomId, f.roomId))
        .for("update");
      reached.release();
      await unblock.wait;
    });
    await reached.wait;
    const parent = createAuthorityParent(db, {
      v: 1,
      action: "create-parent",
      roomId: f.roomId,
      owner: f.operation().actor,
      createOperationId: operationId,
      sceneId: null,
      label: "",
      linkRole: "none",
      initializationDeadline: Date.now() + 900_000,
    });
    const outcome = parent.then(
      () => "created",
      () => "refused",
    );
    const fence = applyStorageFence(db, {
      v: 1,
      action: "fence",
      roomId: f.roomId,
      authorityEpoch: 2,
      authGeneration: 1,
      state: "ended",
    });
    try {
      await waitForBlocked(2);
    } finally {
      unblock.release();
    }
    await holding;
    await fence;
    await outcome;
    // Either lock winner is valid: created parents are ended; absent parents can never appear later.
    const row = await db.query.collaborationRoom.findFirst({
      where: eq(schema.collaborationRoom.roomId, f.roomId),
    });
    if (row) expect(row.storageState).toBe("ended");
    await expect(
      createAuthorityParent(db, {
        v: 1,
        action: "create-parent",
        roomId: f.roomId,
        owner: f.operation().actor,
        createOperationId: operationId,
        sceneId: null,
        label: "",
        linkRole: "none",
        initializationDeadline: Date.now() + 900_000,
      }),
    ).rejects.toThrow("fence-mismatch");
  });
  it("serializes the actual scene freeze against preregistration, then prevents delayed parent creation", async () => {
    const f = await adapterFixture(db);
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, f.owner));
    const [source] = await db
      .insert(schema.scene)
      .values({ userId: f.owner, name: "Retirement source" })
      .returning();
    const target = {
      kind: "scene" as const,
      subject: f.owner,
      sceneId: source!.id,
    };
    const command = await retirementIntent(db, target, f.owner);
    await db
      .insert(schema.collaborationLifecycleSubject)
      .values({
        scope: `account:${f.owner}`,
        kind: "account",
        subject: f.owner,
      })
      .onConflictDoNothing();
    const reached = gate(),
      unblock = gate();
    const held = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.collaborationLifecycleSubject)
        .where(
          eq(schema.collaborationLifecycleSubject.scope, `account:${f.owner}`),
        )
        .for("update");
      reached.release();
      await unblock.wait;
    });
    await reached.wait;
    const freeze = applyLifecycleAdapter(db, {
      v: 1,
      action: "lifecycle-freeze",
      command,
    });
    await waitForBlocked(1);
    const registration = registerAuthorityCommand(db, {
      v: 1,
      action: "register",
      roomId: f.roomId,
      operationId: crypto.randomUUID(),
      identity: f.operation().actor,
      ownerId: f.owner,
      sceneId: source!.id,
      create: true,
    }).then(
      () => "accepted",
      () => "refused",
    );
    try {
      await waitForBlocked(2);
    } finally {
      unblock.release();
    }
    await held;
    expect(await freeze).toEqual({ version: 2 });
    expect(await registration).toBe("refused");
    expect(
      await applyLifecycleAdapter(db, {
        v: 1,
        action: "lifecycle-list",
        command,
        version: 2,
        cursor: null,
      }),
    ).toMatchObject({ rooms: [] });
    expect(
      await db.query.scene.findFirst({
        where: eq(schema.scene.id, source!.id),
      }),
    ).toBeDefined();
  });
  it("rehearses protocol-5 reset, upgrade and rollback while preserving personal, shared, published and Library bytes and attachment references", async () => {
    const f = await adapterFixture(db);
    const [source] = await db
      .insert(schema.scene)
      .values({
        userId: f.owner,
        name: "Preserve",
        sceneData: "exact-personal-document",
        thumbnailFileKey: "preserve-thumbnail",
        isPublished: true,
        publishedSlug: "preserve-fixture",
        publishedSvgKey: "preserve-published",
        publishedSvgUrl: "https://personal.test/artifact",
      })
      .returning();
    await db.insert(schema.sharedScene).values({
      sharedSceneId: "preserve-share",
      ownerId: f.owner,
      compressedData: new Uint8Array([3, 7, 11]),
    });
    await db.insert(schema.personalLibrary).values({
      userId: f.owner,
      compressedData: new Uint8Array([13, 17]),
      byteLength: 2,
      checksum: "a".repeat(64),
    });
    await db.insert(schema.fileRecord).values([
      {
        sceneId: source!.id,
        ownerId: f.owner,
        utFileKey: "preserve-asset",
        excalidrawFileId: "personal-file",
        size: 3,
        url: "https://personal.test/asset",
      },
      {
        sharedSceneId: "preserve-share",
        ownerId: f.owner,
        utFileKey: "preserve-shared",
        excalidrawFileId: "shared-file",
        size: 4,
        url: "https://personal.test/shared",
      },
    ]);
    const preserved = async () => ({
      accounts: await db.select().from(schema.user).orderBy(schema.user.id),
      scenes: await db.select().from(schema.scene).orderBy(schema.scene.id),
      shared: await db
        .select()
        .from(schema.sharedScene)
        .orderBy(schema.sharedScene.sharedSceneId),
      files: await db
        .select()
        .from(schema.fileRecord)
        .orderBy(schema.fileRecord.id),
      library: await db
        .select()
        .from(schema.personalLibrary)
        .orderBy(schema.personalLibrary.userId),
    });
    const before = await preserved();
    const current = await collaborationDDL(schema),
      previous = await collaborationDDL(legacy);
    const names = [...current.names, ...previous.names];
    const apply = async (statements: string[]) =>
      client.begin(async (tx) => {
        for (const statement of resetDDL(names, statements))
          await tx.unsafe(statement);
      });
    await apply(previous.statements);
    await client`INSERT INTO drawstuff_collaboration_room (room_id,scene_id,owner_id,expires_at,created_at,updated_at) VALUES ('old-fixture',${source!.id},${f.owner},now()+interval '1 day',now(),now())`;
    await client`INSERT INTO drawstuff_collaboration_asset (room_id,auth_generation,excalidraw_file_id,crypto_version,byte_length,url,ut_file_key,registered_by,created_at) VALUES ('old-fixture',1,'old-file',1,128,'https://fixture.test/sealed','old-collab-key',${f.owner},now())`;
    await client`INSERT INTO drawstuff_collaboration_asset (room_id,auth_generation,excalidraw_file_id,crypto_version,byte_length,url,ut_file_key,created_at) VALUES ('old-fixture',1,'colliding-file',1,128,'https://fixture.test/sealed','preserve-asset',now())`;
    const manifestSQL = readFileSync(
      new URL(
        "../../../../docs/deployment/collaboration-reset/manifest.sql",
        import.meta.url,
      ),
      "utf8",
    )
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    const manifest = await client.unsafe<{ ut_file_key: string }[]>(
      manifestSQL[0]!,
    );
    expect(manifest.map((row) => row.ut_file_key)).toEqual(["old-collab-key"]);
    const inspectionBefore = await inspectResetDatabase(
      client,
      url,
      "before",
      legacy,
      manifestSQL,
    );
    expect(inspectionBefore.readOnly).toBe(true);
    expect(inspectionBefore.objectKeys).toEqual(["old-collab-key"]);
    expect(inspectionBefore.oldRoomNames).toEqual(["old-fixture-g1"]);
    await expect(
      inspectResetDatabase(client, url, "after", schema, manifestSQL),
    ).rejects.toThrow("differ");
    await client`CREATE TABLE public.external_reset_blocker (room_id varchar(64) REFERENCES drawstuff_collaboration_room(room_id))`;
    await expect(
      inspectResetDatabase(client, url, "before", legacy, manifestSQL),
    ).rejects.toThrow("External foreign keys");
    await client`DROP TABLE public.external_reset_blocker`;
    const cli = fileURLToPath(
      new URL("../../scripts/collaboration-reset-check.mjs", import.meta.url),
    );
    const runCheck = (args: string[]) =>
      /Report: (.+)/.exec(
        execFileSync(process.execPath, [cli, ...args], {
          env: { ...process.env, COLLAB_RESET_DATABASE_URL: url },
          encoding: "utf8",
        }),
      )![1]!;
    const beforeReport = runCheck(["before"]);
    await apply(current.statements);
    let afterReport: string | undefined;
    try {
      afterReport = runCheck(["after", beforeReport]);
      expect(JSON.parse(readFileSync(afterReport, "utf8"))).toMatchObject({
        phase: "after",
        readOnly: true,
      });
    } finally {
      unlinkSync(beforeReport);
      if (afterReport) unlinkSync(afterReport);
    }
    const inspectionAfter = await inspectResetDatabase(
      client,
      url,
      "after",
      schema,
      manifestSQL,
    );
    expect(() =>
      compareResetReports(inspectionBefore, inspectionAfter),
    ).not.toThrow();
    expect(() =>
      compareResetReports(inspectionBefore, {
        ...inspectionAfter,
        target: "other-endpoint",
      }),
    ).toThrow("same database");
    expect(() =>
      compareResetReports(inspectionBefore, {
        ...inspectionAfter,
        personal: [],
      }),
    ).toThrow("changed");
    expect(await preserved()).toEqual(before);
    await db
      .insert(schema.collaborationRoom)
      .values({ roomId: "new-independent", ownerId: f.owner });
    expect(
      await db.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, "new-independent"),
      }),
    ).toMatchObject({ sceneId: null });
    await apply(previous.statements);
    expect(await preserved()).toEqual(before);
    const columns = await client<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_name='drawstuff_collaboration_room'`;
    expect(columns.map((row) => row.column_name)).toContain("expires_at");
    expect(columns.map((row) => row.column_name)).not.toContain(
      "authority_epoch",
    );
    await apply(current.statements);
    expect(await preserved()).toEqual(before);
  });
});
