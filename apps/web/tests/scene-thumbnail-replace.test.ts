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

const { pgClient, testDb } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const testSchema = await import("@/server/db/schema");
  const pgClient = new PGlite();
  return {
    pgClient,
    testDb: drizzle(pgClient, { schema: testSchema }),
  };
});

vi.mock("@/server/db/index", () => ({ db: testDb }));

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import { replaceSceneThumbnail } from "@/server/scene/thumbnail-replace";

const OWNER = "user-owner";

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
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb
    .insert(schema.user)
    .values({ id: OWNER, name: "Owner", email: "owner@example.com" });
});

async function insertScene(thumbnailFileKey: string | null) {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId: OWNER, thumbnailFileKey })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

const thumbnailKeyOf = async (sceneId: string) =>
  (
    await testDb
      .select({ key: schema.scene.thumbnailFileKey })
      .from(schema.scene)
      .where(eq(schema.scene.id, sceneId))
  )[0]?.key ?? null;

const queuedKeys = async () =>
  (await testDb.select().from(schema.deferredFileCleanup)).map((task) => [
    task.utFileKey,
    task.reason,
    task.status,
  ]);

describe("scene thumbnail replacement", () => {
  it("replaces the thumbnail and deletes the previous object", async () => {
    const sceneId = await insertScene("key-0");
    const deleted: string[] = [];

    const result = await replaceSceneThumbnail({
      sceneId,
      fileKey: "key-1",
      fileUrl: "https://files.example/key-1",
      deleteObject: (key) => {
        deleted.push(key);
        return Promise.resolve(true);
      },
    });

    expect(result).toEqual({ applied: true });
    expect(await thumbnailKeyOf(sceneId)).toBe("key-1");
    expect(deleted).toEqual(["key-0"]);
    expect(await queuedKeys()).toEqual([]);
  });

  it("lets two interleaved uploads keep exactly one key and reclaims the losers", async () => {
    // Both calls read the current key before either writes — the historical
    // read-then-write race. The compare-and-set update lets exactly one land;
    // the loser reclaims its own freshly uploaded object. Storage deletion is
    // forced to fail so every losing key must surface in the durable queue.
    const sceneId = await insertScene("key-0");

    const [first, second] = await Promise.all([
      replaceSceneThumbnail({
        sceneId,
        fileKey: "key-a",
        fileUrl: "https://files.example/key-a",
        deleteObject: () => Promise.resolve(false),
      }),
      replaceSceneThumbnail({
        sceneId,
        fileKey: "key-b",
        fileUrl: "https://files.example/key-b",
        deleteObject: () => Promise.resolve(false),
      }),
    ]);

    expect([first.applied, second.applied].filter(Boolean)).toHaveLength(1);
    const survivor = first.applied ? "key-a" : "key-b";
    const loser = first.applied ? "key-b" : "key-a";
    expect(await thumbnailKeyOf(sceneId)).toBe(survivor);
    // The replaced key and the losing upload both wait in the queue.
    expect((await queuedKeys()).sort()).toEqual([
      ["key-0", "replace-thumbnail", "pending"],
      [loser, "replace-thumbnail", "pending"],
    ]);
  });

  it("discards the upload when the scene is gone instead of resurrecting it", async () => {
    const sceneId = await insertScene("key-0");
    await testDb.delete(schema.scene).where(eq(schema.scene.id, sceneId));

    const result = await replaceSceneThumbnail({
      sceneId,
      fileKey: "key-late",
      fileUrl: "https://files.example/key-late",
      deleteObject: () => Promise.resolve(false),
    });

    expect(result).toEqual({ applied: false });
    expect(await queuedKeys()).toEqual([
      ["key-late", "replace-thumbnail", "pending"],
    ]);
  });
});
