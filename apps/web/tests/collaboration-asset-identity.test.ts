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

/**
 * These tests are about the routers' own behaviour, so the shared rate limiter
 * is stubbed to "allowed": leaving it live would send every procedure call at a
 * Redis that does not exist, and the fail-open path would then quietly decide
 * every assertion here. Enforcement itself — including that a real limit
 * produces a 429 and that a degraded limiter still fails closed on every hard
 * guard — is covered in `collaboration-rate-limit-routers.test.ts`.
 */
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: () => Promise.resolve(),
  rateLimitMetadataOf: () => null,
}));

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
import { eq } from "drizzle-orm";

import {
  ASSET_CRYPTO_VERSION,
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ASSET_LOOKUP_BATCH,
  MAX_ROOM_ASSETS_PER_GENERATION,
} from "@drawstuff/collaboration/asset";

import * as schema from "@/server/db/schema";
import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import {
  commitRoomAssetUpload,
  RETIRED_ASSET_CLEANUP_REASON,
} from "@/server/collab/assets";
import type { Database } from "@/server/collab/rooms";
import { QUERIES } from "@/server/db/queries";

/**
 * Asset identity as the storage boundary enforces it (Plan 16), and the room
 * asset writes that identity now governs (Plan 17).
 *
 * The identity property is narrow and was previously wrong: an asset is
 * identified by *parent scope + Excalidraw file id*, and by nothing else. Before
 * Plan 16 an owned-scene asset was keyed by `(scene_id, content_hash)` over the
 * compressed upload payload, which changes on every write — so the same image
 * accumulated a row per save, and two images could in principle collide on a
 * hash. Both directions are asserted here, against real Postgres DDL rather than
 * a mock, because the guarantee is the constraint, not the call site.
 *
 * The room half adds the two things a stored ciphertext needs: an authorization
 * re-check at commit time (an upload takes as long as the bytes take, and access
 * can be revoked while it is in flight) and bounded retention (a rotated
 * generation's assets are unreadable, so their objects have to be handed to the
 * cleanup worker in the same transaction that orphans them).
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

describe("collaboration room assets", () => {
  const CIPHERTEXT_BYTES = 512;

  const upload = (
    roomId: string,
    fileId: string,
    options: {
      userId?: string;
      authGeneration?: number;
      utFileKey?: string;
      byteLength?: number;
      cryptoVersion?: number;
    } = {},
  ) =>
    commitRoomAssetUpload(testDb as unknown as Database, {
      roomId,
      userId: options.userId ?? OWNER,
      authGeneration: options.authGeneration ?? 1,
      fileId,
      storage: {
        cryptoVersion: options.cryptoVersion ?? ASSET_CRYPTO_VERSION,
        utFileKey: options.utFileKey ?? `object-${fileId}`,
        url: `https://storage.example.com/objects/${options.utFileKey ?? `object-${fileId}`}`,
        byteLength: options.byteLength ?? CIPHERTEXT_BYTES,
      },
      now: new Date(),
    });

  const roomAssetRows = (roomId: string) =>
    testDb
      .select({
        fileId: schema.collaborationAsset.excalidrawFileId,
        generation: schema.collaborationAsset.authGeneration,
        utFileKey: schema.collaborationAsset.utFileKey,
        registeredBy: schema.collaborationAsset.registeredBy,
      })
      .from(schema.collaborationAsset)
      .where(eq(schema.collaborationAsset.roomId, roomId));

  it("answers for the current generation when the room has no assets", async () => {
    const room = await openRoom();
    await expect(
      callerFor(OWNER).collaborationAsset.resolve({
        roomId: room.roomId,
        fileIds: [FILE_A],
      }),
    ).resolves.toEqual({
      roomId: room.roomId,
      authGeneration: 1,
      assets: [],
      // Absence is an answer, not an error: a peer's image element arrives before
      // its ciphertext does, and the caller retries exactly these.
      missing: [FILE_A],
    });
  });

  it("records an upload and resolves it back to where the ciphertext is", async () => {
    const room = await openRoom();
    expect(await upload(room.roomId, FILE_A, { utFileKey: "object-1" })).toBe(
      "recorded",
    );

    const lookup = await callerFor(OWNER).collaborationAsset.resolve({
      roomId: room.roomId,
      fileIds: [FILE_A, FILE_B],
    });
    expect(lookup.assets).toEqual([
      {
        excalidrawFileId: FILE_A,
        cryptoVersion: ASSET_CRYPTO_VERSION,
        byteLength: CIPHERTEXT_BYTES,
        url: "https://storage.example.com/objects/object-1",
      },
    ]);
    expect(lookup.missing).toEqual([FILE_B]);
  });

  it("keeps the first upload of a file id and tells the loser to delete its object", async () => {
    const room = await openRoom();
    await addMember(room.roomId, EDITOR, "editor");
    expect(await upload(room.roomId, FILE_A, { utFileKey: "first" })).toBe(
      "recorded",
    );

    // Two peers pasting the same image race here by design. The bytes are the
    // same image either way, so the loser's object simply has no referent.
    expect(
      await upload(room.roomId, FILE_A, {
        userId: EDITOR,
        utFileKey: "second",
      }),
    ).toBe("duplicate");

    const rows = await roomAssetRows(room.roomId);
    expect(rows).toEqual([
      {
        fileId: FILE_A,
        generation: 1,
        utFileKey: "first",
        registeredBy: OWNER,
      },
    ]);
  });

  it("treats different file ids as different assets", async () => {
    const room = await openRoom();
    await upload(room.roomId, FILE_A, { utFileKey: "object-a" });
    await upload(room.roomId, FILE_B, { utFileKey: "object-b" });

    const lookup = await callerFor(OWNER).collaborationAsset.resolve({
      roomId: room.roomId,
      fileIds: [FILE_B, FILE_A],
    });
    expect(lookup.assets.map((asset) => asset.excalidrawFileId)).toEqual([
      FILE_A,
      FILE_B,
    ]);
    expect(lookup.missing).toEqual([]);
  });

  it("rejects an upload from a viewer, a stranger, and an unknown room", async () => {
    const room = await openRoom();
    await addMember(room.roomId, VIEWER, "viewer");

    expect(await upload(room.roomId, FILE_A, { userId: VIEWER })).toBe(
      "rejected",
    );
    expect(await upload(room.roomId, FILE_A, { userId: STRANGER })).toBe(
      "rejected",
    );
    expect(await upload("no-such-room", FILE_A)).toBe("rejected");
    expect(await roomAssetRows(room.roomId)).toEqual([]);

    // A viewer still reads assets: it renders the room, it just does not add to it.
    await upload(room.roomId, FILE_A);
    await expect(
      callerFor(VIEWER).collaborationAsset.resolve({
        roomId: room.roomId,
        fileIds: [FILE_A],
      }),
    ).resolves.toMatchObject({ missing: [] });
  });

  it("rejects an upload sealed for a generation the room has moved past", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });

    // The ciphertext is bound to generation 1; filing it under 2 would produce a
    // row nobody can ever open.
    expect(await upload(room.roomId, FILE_A, { authGeneration: 1 })).toBe(
      "rejected",
    );
    expect(await upload(room.roomId, FILE_A, { authGeneration: 2 })).toBe(
      "recorded",
    );
  });

  it("starts a rotated generation empty and queues the old objects for deletion", async () => {
    const room = await openRoom();
    await upload(room.roomId, FILE_A, { utFileKey: "old-object" });
    await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });

    // The previous generation's ciphertext is unreadable now, so the new
    // generation legitimately has nothing.
    await expect(
      callerFor(OWNER).collaborationAsset.resolve({
        roomId: room.roomId,
        fileIds: [FILE_A],
      }),
    ).resolves.toMatchObject({
      authGeneration: 2,
      assets: [],
      missing: [FILE_A],
    });

    await upload(room.roomId, FILE_B, {
      authGeneration: 2,
      utFileKey: "new-object",
    });
    expect(await roomAssetRows(room.roomId)).toEqual([
      {
        fileId: FILE_B,
        generation: 2,
        utFileKey: "new-object",
        registeredBy: OWNER,
      },
    ]);
    // Deleting the row is what orphans the object, so the same transaction hands
    // it to the cleanup worker.
    expect(
      await testDb
        .select({
          utFileKey: schema.deferredFileCleanup.utFileKey,
          reason: schema.deferredFileCleanup.reason,
          status: schema.deferredFileCleanup.status,
        })
        .from(schema.deferredFileCleanup),
    ).toEqual([
      {
        utFileKey: "old-object",
        reason: RETIRED_ASSET_CLEANUP_REASON,
        status: "pending",
      },
    ]);
  });

  it("bounds the room's asset count and one lookup batch", async () => {
    const room = await openRoom();
    const ids = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) =>
        `${prefix}${String(index).padStart(6, "0")}`.padEnd(40, "0"),
      );

    await expect(
      callerFor(OWNER).collaborationAsset.resolve({
        roomId: room.roomId,
        fileIds: ids(MAX_ASSET_LOOKUP_BATCH + 1, "batch"),
      }),
    ).rejects.toThrow();

    // Fill the generation to its ceiling, then prove the next upload is refused:
    // an authorized member must not be able to grow object storage without limit.
    for (const fileId of ids(MAX_ROOM_ASSETS_PER_GENERATION, "fill")) {
      expect(await upload(room.roomId, fileId)).toBe("recorded");
    }
    expect(await upload(room.roomId, FILE_A)).toBe("budget-exceeded");

    // The refused asset really is absent rather than silently swallowed.
    await expect(
      callerFor(OWNER).collaborationAsset.resolve({
        roomId: room.roomId,
        fileIds: [FILE_A],
      }),
    ).resolves.toMatchObject({ assets: [], missing: [FILE_A] });
  });

  it("refuses a ciphertext length no sealed asset could have", async () => {
    const room = await openRoom();
    await expect(
      upload(room.roomId, FILE_A, { byteLength: 0 }),
    ).rejects.toThrow(/1\.\./);
    await expect(
      upload(room.roomId, FILE_A, {
        byteLength: MAX_ASSET_CIPHERTEXT_BYTES + 1,
      }),
    ).rejects.toThrow();
    expect(await roomAssetRows(room.roomId)).toEqual([]);
  });

  it("removes a room's assets with the room", async () => {
    const room = await openRoom();
    await upload(room.roomId, FILE_A);

    await testDb
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, room.roomId));

    expect(await roomAssetRows(room.roomId)).toEqual([]);
  });

  it("keeps an asset when the member who uploaded it is deleted", async () => {
    const room = await openRoom();
    await addMember(room.roomId, EDITOR, "editor");
    await upload(room.roomId, FILE_A, { userId: EDITOR });

    await testDb.delete(schema.user).where(eq(schema.user.id, EDITOR));

    // Identity does not belong to whoever happened to upload first: the room still
    // references the asset, so the row survives with no uploader.
    expect(await roomAssetRows(room.roomId)).toEqual([
      {
        fileId: FILE_A,
        generation: 1,
        utFileKey: `object-${FILE_A}`,
        registeredBy: null,
      },
    ]);
  });
});
