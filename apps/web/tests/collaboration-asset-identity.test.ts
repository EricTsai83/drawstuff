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

/** The relay is a separate process; asset identity never involves it. */
vi.mock("@/server/collab/relay-control", () => ({
  pushRelayRoomControl: () =>
    Promise.resolve({ enforced: true, closedSessions: 0 }),
}));

/**
 * `QUERIES` writes through the module-level connection, so exercising the
 * identity rules it encodes against real DDL means pointing that connection at
 * the test database. The database has to exist before any module that reads `db`
 * at import time is evaluated, which is what the hoisted block is for.
 */
const { pgClient, testDb } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const testSchema = await import("@/server/db/schema");
  const pgClient = new PGlite();
  return { pgClient, testDb: drizzle(pgClient, { schema: testSchema }) };
});

vi.mock("@/server/db/index", () => ({ db: testDb }));

import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";

import {
  MAX_ASSET_REGISTRATION_BATCH,
  MAX_ROOM_ASSETS_PER_GENERATION,
} from "@drawstuff/collaboration/asset";

import * as schema from "@/server/db/schema";
import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import { QUERIES } from "@/server/db/queries";

/**
 * Asset identity as the storage boundary enforces it (Plan 16).
 *
 * The property under test is narrow and was previously wrong: an asset is
 * identified by *parent scope + Excalidraw file id*, and by nothing else. Before
 * this plan an owned-scene asset was keyed by `(scene_id, content_hash)` over
 * the compressed upload payload, which changes on every write — so the same
 * image accumulated a row per save, and two images could in principle collide on
 * a hash. Both directions are asserted here, against real Postgres DDL rather
 * than a mock, because the guarantee is the constraint, not the call site.
 */

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const STRANGER = "user-stranger";

/** Two distinct engine-generated ids, both valid SHA-1 hex shapes. */
const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);

function callerFor(userId: string | null) {
  const ctx = {
    db: testDb,
    headers: new Headers(),
    auth: userId
      ? { session: { id: `session-${userId}` }, user: { id: userId } }
      : null,
  } as unknown as TRPCContext;
  return createCaller(ctx);
}

async function createScene(userId = OWNER): Promise<string> {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId, sceneData: "stub" })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

async function createSharedScene(id: string, ownerId = OWNER): Promise<string> {
  await testDb
    .insert(schema.sharedScene)
    .values({ sharedSceneId: id, ownerId });
  return id;
}

const sceneAsset = (
  sceneId: string,
  excalidrawFileId: string,
  overrides: { utFileKey?: string; contentHash?: string | null } = {},
) =>
  QUERIES.createFileRecord({
    sceneId,
    ownerId: OWNER,
    utFileKey: overrides.utFileKey ?? `key-${excalidrawFileId}`,
    contentHash: overrides.contentHash ?? "c".repeat(64),
    excalidrawFileId,
    size: 128,
    url: `https://files.example/${excalidrawFileId}`,
  });

const listSceneAssets = (sceneId: string) =>
  testDb
    .select({
      excalidrawFileId: schema.fileRecord.excalidrawFileId,
      utFileKey: schema.fileRecord.utFileKey,
      contentHash: schema.fileRecord.contentHash,
    })
    .from(schema.fileRecord)
    .where(eq(schema.fileRecord.sceneId, sceneId));

async function openRoom(
  options: { linkRole?: "none" | "viewer" | "editor" } = {},
) {
  const sceneId = await createScene(OWNER);
  return callerFor(OWNER).collaborationRoom.create({
    sceneId,
    linkRole: options.linkRole ?? "none",
  });
}

async function addMember(
  roomId: string,
  userId: string,
  role: "editor" | "viewer",
) {
  await testDb
    .insert(schema.collaborationRoomMember)
    .values({ roomId, userId, role });
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
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.collaborationRoomMember);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.sharedScene);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: EDITOR, name: "Editor", email: "editor@example.com" },
    { id: VIEWER, name: "Viewer", email: "viewer@example.com" },
    { id: STRANGER, name: "Stranger", email: "stranger@example.com" },
  ]);
});

describe("scene asset identity", () => {
  it("keeps two assets with identical content but different file ids", async () => {
    const sceneId = await createScene();
    const sharedHash = "d".repeat(64);

    await sceneAsset(sceneId, FILE_A, { contentHash: sharedHash });
    await sceneAsset(sceneId, FILE_B, { contentHash: sharedHash });

    // The old identity would have stored one of these and deleted the other's
    // upload, leaving an image element pointing at nothing.
    const rows = await listSceneAssets(sceneId);
    expect(rows.map((row) => row.excalidrawFileId).sort()).toEqual([
      FILE_A,
      FILE_B,
    ]);
    expect(new Set(rows.map((row) => row.contentHash))).toEqual(
      new Set([sharedHash]),
    );
  });

  it("treats a re-upload of the same file id as a no-op retry", async () => {
    const sceneId = await createScene();
    const first = await sceneAsset(sceneId, FILE_A, { utFileKey: "key-first" });
    expect(first).toHaveLength(1);

    // A retry uploads to a fresh storage key: the payload is recompressed, so
    // the bytes (and their hash) differ even though the image does not.
    const retry = await sceneAsset(sceneId, FILE_A, {
      utFileKey: "key-retry",
      contentHash: "e".repeat(64),
    });

    // Empty result is the caller's signal to delete the upload it just made.
    expect(retry).toEqual([]);
    const rows = await listSceneAssets(sceneId);
    expect(rows).toHaveLength(1);
    // The surviving row is the first one; the retry never rewrote the pointer.
    expect(rows[0]?.utFileKey).toBe("key-first");
  });

  it("admits exactly one row when the same identity is written twice at once", async () => {
    const sceneId = await createScene();

    // PGlite serializes these, so this asserts that the constraint decides the
    // winner rather than simulating parallel connections: without a unique
    // identity index both inserts would land and the scene would carry a
    // duplicate asset.
    const results = await Promise.all([
      sceneAsset(sceneId, FILE_A, { utFileKey: "key-1" }),
      sceneAsset(sceneId, FILE_A, { utFileKey: "key-2" }),
    ]);

    expect(results.filter((result) => result.length === 1)).toHaveLength(1);
    expect(results.filter((result) => result.length === 0)).toHaveLength(1);
    expect(await listSceneAssets(sceneId)).toHaveLength(1);
  });

  it("scopes identity to the parent, so two scenes may hold the same file id", async () => {
    const first = await createScene();
    const second = await createScene();

    await sceneAsset(first, FILE_A, { utFileKey: "key-first" });
    await sceneAsset(second, FILE_A, { utFileKey: "key-second" });

    expect(await listSceneAssets(first)).toHaveLength(1);
    expect(await listSceneAssets(second)).toHaveLength(1);
  });

  it("applies the same identity to shared scenes", async () => {
    const sharedSceneId = await createSharedScene("shared-1");
    const insert = (excalidrawFileId: string, utFileKey: string) =>
      QUERIES.createFileRecord({
        sharedSceneId,
        ownerId: OWNER,
        utFileKey,
        excalidrawFileId,
        size: 64,
        url: `https://files.example/${utFileKey}`,
      });

    expect(await insert(FILE_A, "shared-key-1")).toHaveLength(1);
    expect(await insert(FILE_A, "shared-key-2")).toEqual([]);
    expect(await insert(FILE_B, "shared-key-3")).toHaveLength(1);

    const rows = await QUERIES.getFileRecordsBySharedSceneId(sharedSceneId);
    expect(rows.map((row) => row.excalidrawFileId).sort()).toEqual([
      FILE_A,
      FILE_B,
    ]);
  });

  it("refuses a record whose parent is missing or ambiguous", async () => {
    const sceneId = await createScene();
    await expect(
      QUERIES.createFileRecord({
        ownerId: OWNER,
        utFileKey: "key-none",
        excalidrawFileId: FILE_A,
        size: 1,
        url: "https://files.example/none",
      }),
    ).rejects.toThrow(/Either sceneId or sharedSceneId/);
    await expect(
      QUERIES.createFileRecord({
        sceneId,
        sharedSceneId: "shared-1",
        ownerId: OWNER,
        utFileKey: "key-both",
        excalidrawFileId: FILE_A,
        size: 1,
        url: "https://files.example/both",
      }),
    ).rejects.toThrow(/Cannot provide both/);
  });

  it("refuses an unusable file id at the database boundary", async () => {
    const sceneId = await createScene();
    // The shape check is the last line of defence: an empty or punctuated id
    // would be an asset no element could ever address.
    await expect(sceneAsset(sceneId, "")).rejects.toThrow();
    await expect(sceneAsset(sceneId, "not/a/file/id")).rejects.toThrow();
  });

  it("removes asset records with their parent", async () => {
    const sceneId = await createScene();
    const sharedSceneId = await createSharedScene("shared-cascade");
    await sceneAsset(sceneId, FILE_A);
    await QUERIES.createFileRecord({
      sharedSceneId,
      ownerId: OWNER,
      utFileKey: "shared-cascade-key",
      excalidrawFileId: FILE_A,
      size: 8,
      url: "https://files.example/shared",
    });

    await testDb.delete(schema.scene).where(eq(schema.scene.id, sceneId));
    expect(await listSceneAssets(sceneId)).toEqual([]);

    await testDb
      .delete(schema.sharedScene)
      .where(eq(schema.sharedScene.sharedSceneId, sharedSceneId));
    expect(await QUERIES.getFileRecordsBySharedSceneId(sharedSceneId)).toEqual(
      [],
    );
  });
});

describe("collaboration asset manifest", () => {
  it("starts empty and reports the generation it answers for", async () => {
    const room = await openRoom();
    await expect(
      callerFor(OWNER).collaborationAsset.list({ roomId: room.roomId }),
    ).resolves.toEqual({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [],
    });
  });

  it("registers ids once, ascending, and treats a repeat as success", async () => {
    const room = await openRoom();
    const first = await callerFor(OWNER).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [FILE_B, FILE_A],
    });
    expect(first).toEqual({
      authGeneration: 1,
      registered: [FILE_A, FILE_B],
      alreadyPresent: [],
      fileIds: [FILE_A, FILE_B],
    });

    // A retry after a dropped response must not fail and must not duplicate.
    const retry = await callerFor(OWNER).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [FILE_A],
    });
    expect(retry).toEqual({
      authGeneration: 1,
      registered: [],
      alreadyPresent: [FILE_A],
      fileIds: [FILE_A, FILE_B],
    });
    expect(
      await testDb
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.roomId, room.roomId)),
    ).toHaveLength(2);
  });

  it("collapses a batch that names the same asset twice", async () => {
    const room = await openRoom();
    const result = await callerFor(OWNER).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [FILE_A, FILE_A, FILE_A],
    });
    expect(result.registered).toEqual([FILE_A]);
    expect(result.fileIds).toEqual([FILE_A]);
  });

  it("lets an editor register and refuses a viewer", async () => {
    const room = await openRoom();
    await addMember(room.roomId, EDITOR, "editor");
    await addMember(room.roomId, VIEWER, "viewer");

    await expect(
      callerFor(EDITOR).collaborationAsset.register({
        roomId: room.roomId,
        authGeneration: 1,
        fileIds: [FILE_A],
      }),
    ).resolves.toMatchObject({ registered: [FILE_A] });

    // A viewer receives the manifest but never extends it — the relay refuses
    // its realtime mutations and this refuses the durable equivalent.
    await expect(
      callerFor(VIEWER).collaborationAsset.register({
        roomId: room.roomId,
        authGeneration: 1,
        fileIds: [FILE_B],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(VIEWER).collaborationAsset.list({ roomId: room.roomId }),
    ).resolves.toMatchObject({ fileIds: [FILE_A] });
  });

  it("refuses a stranger and an unknown room", async () => {
    const room = await openRoom();
    await expect(
      callerFor(STRANGER).collaborationAsset.list({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(OWNER).collaborationAsset.list({ roomId: "no-such-room" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a registration filed under a stale generation", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });

    await expect(
      callerFor(OWNER).collaborationAsset.register({
        roomId: room.roomId,
        authGeneration: 1,
        fileIds: [FILE_A],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("starts a rotated generation from an empty manifest and retires the old one", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [FILE_A],
    });

    const rotated = await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });
    expect(rotated.authGeneration).toBe(2);

    // The previous generation's assets are sealed under a key nobody can derive
    // any more, so the new generation legitimately references nothing yet.
    await expect(
      callerFor(OWNER).collaborationAsset.list({ roomId: room.roomId }),
    ).resolves.toEqual({
      roomId: room.roomId,
      authGeneration: 2,
      fileIds: [],
    });

    await callerFor(OWNER).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 2,
      fileIds: [FILE_B],
    });
    // Retention is bounded: the write that gave generation 2 a manifest is what
    // retires generation 1's.
    expect(
      await testDb
        .select({ generation: schema.collaborationAsset.authGeneration })
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.roomId, room.roomId)),
    ).toEqual([{ generation: 2 }]);
  });

  it("bounds one request and the room's total asset count", async () => {
    const room = await openRoom();
    const ids = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) =>
        `${prefix}${String(index).padStart(6, "0")}`.padEnd(40, "0"),
      );

    await expect(
      callerFor(OWNER).collaborationAsset.register({
        roomId: room.roomId,
        authGeneration: 1,
        fileIds: ids(MAX_ASSET_REGISTRATION_BATCH + 1, "batch"),
      }),
    ).rejects.toThrow();

    // Fill the generation to its ceiling in permitted batches, then prove the
    // next asset is refused: an authorized member must not be able to grow the
    // manifest without limit.
    const all = ids(MAX_ROOM_ASSETS_PER_GENERATION, "fill");
    for (
      let index = 0;
      index < all.length;
      index += MAX_ASSET_REGISTRATION_BATCH
    ) {
      await callerFor(OWNER).collaborationAsset.register({
        roomId: room.roomId,
        authGeneration: 1,
        fileIds: all.slice(index, index + MAX_ASSET_REGISTRATION_BATCH),
      });
    }
    await expect(
      callerFor(OWNER).collaborationAsset.register({
        roomId: room.roomId,
        authGeneration: 1,
        fileIds: [FILE_A],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // The refused asset really is absent, not silently swallowed.
    const manifest = await callerFor(OWNER).collaborationAsset.list({
      roomId: room.roomId,
    });
    expect(manifest.fileIds).toHaveLength(MAX_ROOM_ASSETS_PER_GENERATION);
    expect(manifest.fileIds).not.toContain(FILE_A);
  });

  it("removes a room's manifest with the room", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [FILE_A],
    });

    await testDb
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, room.roomId));

    expect(
      await testDb
        .select()
        .from(schema.collaborationAsset)
        .where(eq(schema.collaborationAsset.roomId, room.roomId)),
    ).toEqual([]);
  });

  it("keeps a manifest entry when the member who registered it is deleted", async () => {
    const room = await openRoom();
    await addMember(room.roomId, EDITOR, "editor");
    await callerFor(EDITOR).collaborationAsset.register({
      roomId: room.roomId,
      authGeneration: 1,
      fileIds: [FILE_A],
    });

    await testDb.delete(schema.user).where(eq(schema.user.id, EDITOR));

    // Identity does not belong to whoever happened to upload first: the room
    // still references the asset, so the entry survives with no registrant.
    expect(
      await testDb
        .select({
          fileId: schema.collaborationAsset.excalidrawFileId,
          registeredBy: schema.collaborationAsset.registeredBy,
        })
        .from(schema.collaborationAsset)
        .where(
          and(
            eq(schema.collaborationAsset.roomId, room.roomId),
            eq(schema.collaborationAsset.authGeneration, 1),
          ),
        ),
    ).toEqual([{ fileId: FILE_A, registeredBy: null }]);
  });
});
