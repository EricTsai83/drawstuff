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

/**
 * The action under test reaches the database, the session and the storage
 * provider at module scope, so all three are redirected here. The database has
 * to exist before any module that reads `db` at import time is evaluated.
 */
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
import { cleanupSceneAssetUploadsAction } from "@/server/actions";
import { QUERIES } from "@/server/db/queries";

import {
  planSceneAssetCleanup,
  readReferencedSceneAssetIds,
} from "@/server/scene/referenced-assets";
import { compressData } from "@/lib/encode";
import {
  createOwnedSceneDocumentV4,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

/**
 * Retention when an aborted save cleans up its own uploads (Plan 16 review fix).
 *
 * Asset identity is per Excalidraw file id, so the second upload of the same
 * image is refused as a retry rather than stored twice. That removes the
 * accidental redundancy the old duplicate-per-save behaviour provided, and with
 * it the assumption a failing save could rely on: the row its upload created may
 * be the *only* record for an asset that a concurrent save has since committed.
 *
 * The rule these tests pin is therefore "the committed document decides", not
 * "the failing request deletes what it uploaded".
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

/** Encodes a scene exactly the way the owned-scene writer stores it. */
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

describe("referenced scene assets", () => {
  it("reports the file ids of live image elements", async () => {
    const sceneData = await storedScene([
      imageElement(FILE_A, "el-a"),
      imageElement(FILE_B, "el-b"),
    ]);
    await expect(readReferencedSceneAssetIds(sceneData)).resolves.toEqual(
      new Set([FILE_A, FILE_B]),
    );
  });

  it("ignores an image element that was deleted", async () => {
    const deleted = {
      ...imageElement(FILE_B, "el-b"),
      isDeleted: true,
    } as ExcalidrawElement;
    const sceneData = await storedScene([
      imageElement(FILE_A, "el-a"),
      deleted,
    ]);
    await expect(readReferencedSceneAssetIds(sceneData)).resolves.toEqual(
      new Set([FILE_A]),
    );
  });

  it("treats an empty scene as referencing nothing", async () => {
    await expect(readReferencedSceneAssetIds(null)).resolves.toEqual(new Set());
  });

  it("reports unreadable rather than empty when the document cannot be parsed", async () => {
    // Distinct from an empty set on purpose: the two must lead to opposite
    // cleanup decisions.
    await expect(readReferencedSceneAssetIds("not-base64-scene")).resolves.toBe(
      null,
    );
  });
});

describe("scene asset cleanup plan", () => {
  it("deletes a key that no record points at", () => {
    // The refused duplicate upload: the server already removed the object and
    // no row was created, so nothing can resolve it.
    expect(
      planSceneAssetCleanup({
        requestedKeys: ["key-orphan"],
        records: [],
        referencedFileIds: new Set([FILE_A]),
      }),
    ).toEqual({ deletableKeys: ["key-orphan"], retainedKeys: [] });
  });

  it("retains the only record of an asset the committed scene still references", () => {
    // The concurrency case: this request's upload created the row, this
    // request's save then lost the revision race, and the scene that won
    // references the asset.
    expect(
      planSceneAssetCleanup({
        requestedKeys: ["key-a"],
        records: [{ utFileKey: "key-a", excalidrawFileId: FILE_A }],
        referencedFileIds: new Set([FILE_A]),
      }),
    ).toEqual({ deletableKeys: [], retainedKeys: ["key-a"] });
  });

  it("deletes a record the committed scene does not reference", () => {
    expect(
      planSceneAssetCleanup({
        requestedKeys: ["key-b"],
        records: [{ utFileKey: "key-b", excalidrawFileId: FILE_B }],
        referencedFileIds: new Set([FILE_A]),
      }),
    ).toEqual({ deletableKeys: ["key-b"], retainedKeys: [] });
  });

  it("retains every record when the document cannot be read", () => {
    // Keeping an orphaned object costs storage; deleting a referenced one loses
    // a user's image.
    expect(
      planSceneAssetCleanup({
        requestedKeys: ["key-a", "key-orphan"],
        records: [{ utFileKey: "key-a", excalidrawFileId: FILE_A }],
        referencedFileIds: null,
      }),
    ).toEqual({ deletableKeys: ["key-orphan"], retainedKeys: ["key-a"] });
  });

  it("splits a mixed batch and deduplicates the requested keys", () => {
    expect(
      planSceneAssetCleanup({
        requestedKeys: ["key-a", "key-a", "key-b", "key-orphan"],
        records: [
          { utFileKey: "key-a", excalidrawFileId: FILE_A },
          { utFileKey: "key-b", excalidrawFileId: FILE_B },
        ],
        referencedFileIds: new Set([FILE_A]),
      }),
    ).toEqual({
      deletableKeys: ["key-b", "key-orphan"],
      retainedKeys: ["key-a"],
    });
  });
});

describe("cleanupSceneAssetUploadsAction", () => {
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

  async function sceneWith(elements: readonly ExcalidrawElement[]) {
    const [row] = await testDb
      .insert(schema.scene)
      .values({
        name: "scene",
        userId: OWNER,
        sceneData: await storedScene(elements),
      })
      .returning({ id: schema.scene.id });
    if (!row) throw new Error("failed to insert scene");
    return row.id;
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

  const remainingKeys = async (sceneId: string) =>
    (
      await testDb
        .select({ utFileKey: schema.fileRecord.utFileKey })
        .from(schema.fileRecord)
        .where(eq(schema.fileRecord.sceneId, sceneId))
    ).map((row) => row.utFileKey);

  it("keeps the asset a concurrently committed save still references", async () => {
    // Save A uploaded FILE_A and created the only record for it; save B then won
    // the revision race with a document that references FILE_A; save A now runs
    // its rollback. Deleting by uploaded key alone would strip B's image.
    const sceneId = await sceneWith([imageElement(FILE_A, "el-a")]);
    await record(sceneId, FILE_A, "key-a");

    const result = await cleanupSceneAssetUploadsAction({
      sceneId,
      fileKeys: ["key-a"],
    });

    expect(result).toEqual({ success: true, retainedFileKeys: ["key-a"] });
    expect(await remainingKeys(sceneId)).toEqual(["key-a"]);
    expect(deletedObjectKeys).toEqual([]);
  });

  it("removes an upload the committed scene does not reference", async () => {
    const sceneId = await sceneWith([imageElement(FILE_A, "el-a")]);
    await record(sceneId, FILE_A, "key-a");
    await record(sceneId, FILE_B, "key-b");

    const result = await cleanupSceneAssetUploadsAction({
      sceneId,
      fileKeys: ["key-a", "key-b"],
    });

    expect(result).toEqual({ success: true, retainedFileKeys: ["key-a"] });
    expect(await remainingKeys(sceneId)).toEqual(["key-a"]);
    expect(deletedObjectKeys).toEqual(["key-b"]);
  });

  it("removes a refused duplicate upload that never became a record", async () => {
    const sceneId = await sceneWith([imageElement(FILE_A, "el-a")]);
    await record(sceneId, FILE_A, "key-a");

    // The retry's own upload: identity conflict, so no row was created for it.
    const result = await cleanupSceneAssetUploadsAction({
      sceneId,
      fileKeys: ["key-retry"],
    });

    expect(result).toEqual({ success: true, retainedFileKeys: [] });
    expect(await remainingKeys(sceneId)).toEqual(["key-a"]);
    expect(deletedObjectKeys).toEqual(["key-retry"]);
  });

  it("keeps every record when the stored document cannot be read", async () => {
    const [row] = await testDb
      .insert(schema.scene)
      .values({ name: "scene", userId: OWNER, sceneData: "not-a-document" })
      .returning({ id: schema.scene.id });
    const sceneId = row?.id;
    if (!sceneId) throw new Error("failed to insert scene");
    await record(sceneId, FILE_A, "key-a");

    const result = await cleanupSceneAssetUploadsAction({
      sceneId,
      fileKeys: ["key-a"],
    });

    expect(result).toEqual({ success: true, retainedFileKeys: ["key-a"] });
    expect(await remainingKeys(sceneId)).toEqual(["key-a"]);
    expect(deletedObjectKeys).toEqual([]);
  });

  it("refuses a scene the caller does not own", async () => {
    const sceneId = await sceneWith([imageElement(FILE_A, "el-a")]);
    await record(sceneId, FILE_A, "key-a");
    await testDb
      .insert(schema.user)
      .values({ id: "other", name: "Other", email: "other@example.com" });
    await testDb
      .update(schema.scene)
      .set({ userId: "other" })
      .where(eq(schema.scene.id, sceneId));

    const result = await cleanupSceneAssetUploadsAction({
      sceneId,
      fileKeys: ["key-a"],
    });

    expect(result.success).toBe(false);
    expect(await remainingKeys(sceneId)).toEqual(["key-a"]);
    expect(deletedObjectKeys).toEqual([]);
  });
});
