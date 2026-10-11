// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const OWNER = "user-owner";

const { pgClient, testDb, storageCalls } = await vi.hoisted(async () => {
  const { createTestDatabase } = await import("../support/pglite-db");
  return { ...createTestDatabase(), storageCalls: [] as string[] };
});

vi.mock("@/server/db/index", () => ({ db: testDb }));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: () => Promise.resolve({ user: { id: OWNER } }),
}));
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles(keys: string[]) {
      storageCalls.push(...keys);
      return Promise.resolve({ success: true });
    }
  },
}));

import * as schema from "@/server/db/schema";
import { registerTestDatabase } from "../support/pglite-db";
import { rollbackSharedScene } from "@/server/actions";
import { QUERIES } from "@/server/db/queries";

describe("rollbackSharedScene", () => {
  registerTestDatabase({ pgClient, testDb });

  beforeEach(async () => {
    storageCalls.length = 0;
    await testDb.delete(schema.fileRecord);
    await testDb.delete(schema.deferredFileCleanup);
    await testDb.delete(schema.sharedScene);
    await testDb.delete(schema.user);
    await testDb.insert(schema.user).values([
      { id: OWNER, name: "Owner", email: "owner@example.com" },
      { id: "other", name: "Other", email: "other@example.com" },
    ]);
  });

  async function sharedSceneWithAsset(ownerId: string, key: string) {
    await testDb
      .insert(schema.sharedScene)
      .values({ sharedSceneId: `share-${key}`, ownerId });
    await QUERIES.createFileRecord({
      sharedSceneId: `share-${key}`,
      ownerId,
      utFileKey: key,
      excalidrawFileId: key.padEnd(40, "0"),
      size: 32,
      url: `https://files.example/${key}`,
    });
    return `share-${key}`;
  }

  it("deletes the rows and hands uploaded objects to the cleanup outbox", async () => {
    const id = await sharedSceneWithAsset(OWNER, "key-a");

    await expect(rollbackSharedScene(id)).resolves.toEqual({ success: true });

    expect(await testDb.select().from(schema.sharedScene)).toEqual([]);
    expect(await testDb.select().from(schema.fileRecord)).toEqual([]);
    const queued = await testDb.select().from(schema.deferredFileCleanup);
    expect(queued.map((row) => [row.utFileKey, row.reason])).toEqual([
      ["key-a", "sharedScene_rollback"],
    ]);
    // Storage is drained by maintenance, never touched inline.
    expect(storageCalls).toEqual([]);
  });

  it("refuses another user's shared scene and leaves it intact", async () => {
    const id = await sharedSceneWithAsset("other", "key-b");

    const result = await rollbackSharedScene(id);

    expect(result.success).toBe(false);
    expect(await testDb.select().from(schema.sharedScene)).toHaveLength(1);
    expect(await testDb.select().from(schema.fileRecord)).toHaveLength(1);
    expect(await testDb.select().from(schema.deferredFileCleanup)).toEqual([]);
  });
});
