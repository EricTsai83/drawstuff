// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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

/** The Durable Object is separate; asset identity never involves it. */
vi.mock("@/server/collab/do-control", () => ({
  pushDoRoomControl: () =>
    Promise.resolve({ enforced: true, closedSessions: 0 }),
}));

/**
 * `QUERIES` writes through the module-level connection, so exercising the
 * identity rules it encodes against real DDL means pointing that connection at
 * the test database. The database has to exist before any module that reads `db`
 * at import time is evaluated, which is what the hoisted block is for.
 */
const { pgClient, testDb } = await vi.hoisted(async () => {
  const { createTestDatabase } = await import("./support/pglite-db");
  return createTestDatabase();
});

vi.mock("@/server/db/index", () => ({ db: testDb }));

import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import { registerTestDatabase } from "./support/pglite-db";
import { QUERIES } from "@/server/db/queries";

/** Personal/shared scene identity remains independent of the Room attachment authority. Room storage invariants are covered by the authority adapter suite. */

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const STRANGER = "user-stranger";

/** Two distinct engine-generated ids, both valid SHA-1 hex shapes. */
const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);

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

registerTestDatabase({ pgClient, testDb });

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
