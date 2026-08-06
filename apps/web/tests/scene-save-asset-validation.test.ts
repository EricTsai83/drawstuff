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

const OWNER = "user-owner";

const { pgClient, testDb, deletedObjectKeys } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const testSchema = await import("@/server/db/schema");
  const pgClient = new PGlite();
  return {
    pgClient,
    testDb: drizzle(pgClient, { schema: testSchema }),
    deletedObjectKeys: [] as string[],
  };
});

vi.mock("@/server/db/index", () => ({ db: testDb }));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: () => Promise.resolve({ user: { id: OWNER } }),
}));
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles(keys: string[]) {
      deletedObjectKeys.push(...keys);
      return Promise.resolve({ success: true });
    }
  },
}));

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import {
  cleanupSceneAssetUploadsAction,
  saveSceneAction,
} from "@/server/actions";
import { QUERIES } from "@/server/db/queries";
import { APP_ERROR } from "@/lib/errors";
import { readReferencedSceneAssetIds } from "@/server/scene/referenced-assets";
import { compressData } from "@/lib/encode";
import {
  createOwnedSceneDocumentV4,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

/**
 * Save-time asset validation and its serialization against aborted-save
 * cleanup (Plan 23).
 *
 * The invariant both directions protect: a committed scene document never
 * references an Excalidraw file id that has no `file_record`, because the
 * record is the only map from the id to the stored bytes. The save transaction
 * verifies its references under the scene row lock; the cleanup transaction
 * decides and deletes under the same lock, so neither can slip between the
 * other's read and commit.
 */

const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);

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
  deletedObjectKeys.length = 0;
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb
    .insert(schema.user)
    .values({ id: OWNER, name: "Owner", email: "owner@example.com" });
});

async function insertScene(sceneData: string | null) {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId: OWNER, sceneData })
    .returning({ id: schema.scene.id, revision: schema.scene.revision });
  if (!row) throw new Error("failed to insert scene");
  return row;
}

const record = (sceneId: string, fileId: string, utFileKey: string) =>
  QUERIES.createFileRecord({
    sceneId,
    ownerId: OWNER,
    utFileKey,
    excalidrawFileId: fileId,
    size: 32,
    url: `https://files.example/${utFileKey}`,
  });

const save = async (
  sceneId: string,
  revision: number,
  elements: readonly ExcalidrawElement[],
) =>
  saveSceneAction({
    id: sceneId,
    name: "scene",
    data: await storedScene(elements),
    expectedRevision: revision,
  });

const committedDoc = async (sceneId: string) => {
  const [row] = await testDb
    .select({
      sceneData: schema.scene.sceneData,
      revision: schema.scene.revision,
    })
    .from(schema.scene)
    .where(eq(schema.scene.id, sceneId));
  if (!row) throw new Error("scene disappeared");
  return row;
};

describe("save-time asset validation", () => {
  it("rejects a save whose document references an asset with no record", async () => {
    const scene = await insertScene(null);

    const result = await save(scene.id, scene.revision, [
      imageElement(FILE_A, "el-a"),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe(APP_ERROR.SCENE_ASSETS_MISSING);
    expect(result.missingFileIds).toEqual([FILE_A]);

    // The whole write rolled back: the draft is still a draft.
    const after = await committedDoc(scene.id);
    expect(after.sceneData).toBeNull();
    expect(after.revision).toBe(scene.revision);
  });

  it("reports only the ids that are missing", async () => {
    const scene = await insertScene(null);
    await record(scene.id, FILE_A, "key-a");

    const result = await save(scene.id, scene.revision, [
      imageElement(FILE_A, "el-a"),
      imageElement(FILE_B, "el-b"),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe(APP_ERROR.SCENE_ASSETS_MISSING);
    expect(result.missingFileIds).toEqual([FILE_B]);
  });

  it("commits when every referenced asset has a record", async () => {
    const scene = await insertScene(null);
    await record(scene.id, FILE_A, "key-a");

    const result = await save(scene.id, scene.revision, [
      imageElement(FILE_A, "el-a"),
    ]);

    expect(result.ok).toBe(true);
  });

  it("commits a document that references nothing without any records", async () => {
    const scene = await insertScene(null);

    const result = await save(scene.id, scene.revision, []);

    expect(result.ok).toBe(true);
  });

  it("ignores deleted image elements when validating", async () => {
    const scene = await insertScene(null);
    const deleted = {
      ...imageElement(FILE_A, "el-a"),
      isDeleted: true,
    } as ExcalidrawElement;

    const result = await save(scene.id, scene.revision, [deleted]);

    expect(result.ok).toBe(true);
  });
});

describe("cleanup and save serialization", () => {
  it("cleanup first: save is rejected and the client can recover", async () => {
    // The scene's committed document references only FILE_A; FILE_B's record
    // came from an upload whose save never committed.
    const scene = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(scene.id, FILE_A, "key-a");
    await record(scene.id, FILE_B, "key-b");

    const cleanup = await cleanupSceneAssetUploadsAction({
      sceneId: scene.id,
      fileKeys: ["key-b"],
    });
    expect(cleanup).toEqual({ success: true, retainedFileKeys: [] });
    expect(deletedObjectKeys).toEqual(["key-b"]);

    // A save that still references FILE_B now fails loudly instead of
    // committing a reference to bytes that are gone.
    const result = await save(scene.id, scene.revision, [
      imageElement(FILE_A, "el-a"),
      imageElement(FILE_B, "el-b"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe(APP_ERROR.SCENE_ASSETS_MISSING);
    expect(result.missingFileIds).toEqual([FILE_B]);

    // Re-upload (new record) then retry — the client-side recovery path.
    await record(scene.id, FILE_B, "key-b2");
    const retry = await save(scene.id, scene.revision, [
      imageElement(FILE_A, "el-a"),
      imageElement(FILE_B, "el-b"),
    ]);
    expect(retry.ok).toBe(true);
  });

  it("save first: cleanup retains the asset the new document references", async () => {
    const scene = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(scene.id, FILE_A, "key-a");
    await record(scene.id, FILE_B, "key-b");

    const result = await save(scene.id, scene.revision, [
      imageElement(FILE_A, "el-a"),
      imageElement(FILE_B, "el-b"),
    ]);
    expect(result.ok).toBe(true);

    const cleanup = await cleanupSceneAssetUploadsAction({
      sceneId: scene.id,
      fileKeys: ["key-b"],
    });
    expect(cleanup).toEqual({ success: true, retainedFileKeys: ["key-b"] });
    expect(deletedObjectKeys).toEqual([]);
  });

  it("concurrent save and cleanup never leave a committed reference without a record", async () => {
    const scene = await insertScene(
      await storedScene([imageElement(FILE_A, "el-a")]),
    );
    await record(scene.id, FILE_A, "key-a");
    await record(scene.id, FILE_B, "key-b");

    const [saveResult, cleanupResult] = await Promise.all([
      save(scene.id, scene.revision, [
        imageElement(FILE_A, "el-a"),
        imageElement(FILE_B, "el-b"),
      ]),
      cleanupSceneAssetUploadsAction({
        sceneId: scene.id,
        fileKeys: ["key-b"],
      }),
    ]);
    expect(cleanupResult.success).toBe(true);

    // Whichever order the row lock imposed, the committed document's
    // references must all resolve to records.
    const after = await committedDoc(scene.id);
    const referenced = await readReferencedSceneAssetIds(after.sceneData);
    expect(referenced).not.toBeNull();
    const remainingRows = await testDb
      .select({ excalidrawFileId: schema.fileRecord.excalidrawFileId })
      .from(schema.fileRecord)
      .where(eq(schema.fileRecord.sceneId, scene.id));
    const remaining = new Set(remainingRows.map((row) => row.excalidrawFileId));
    for (const fileId of referenced ?? []) {
      expect(remaining.has(fileId)).toBe(true);
    }

    // And the save reported one of the two legal outcomes.
    if (saveResult.ok) {
      expect(referenced).toEqual(new Set([FILE_A, FILE_B]));
      expect(deletedObjectKeys).toEqual([]);
    } else {
      expect(saveResult.error).toBe(APP_ERROR.SCENE_ASSETS_MISSING);
      expect(referenced).toEqual(new Set([FILE_A]));
    }
  });
});
