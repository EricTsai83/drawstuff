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
import { saveOwnedScene } from "@/server/scene/save-owned-scene";
import { compressData } from "@/lib/encode";
import {
  createOwnedSceneDocumentV4,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";

const OWNER = "user-owner";

async function emptySceneData(): Promise<string> {
  const document = createOwnedSceneDocumentV4({
    elements: [],
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
  await testDb.delete(schema.sceneCategory);
  await testDb.delete(schema.category);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb
    .insert(schema.user)
    .values({ id: OWNER, name: "Owner", email: "owner@example.com" });
});

describe("concurrent saves introducing the same new category (plan 03 M6)", () => {
  // PGlite 只有單一 session，兩個 transaction 會被驅動層序列化，因此真正的
  // 23505 race window 在這個 harness 裡無法重現；這個測試釘住的是使用者可見
  // 不變量：兩個並發 save 都必須成功、同名分類只留一列、兩個 scene 都掛上
  // 同一個分類 id。onConflictDoNothing + 重查的 conflict 分支由此路徑的
  // SQL 語意（與 category.create 相同機制）保證。
  it("both saves succeed and share one category row", async () => {
    const data = await emptySceneData();
    const [first, second] = await Promise.all([
      saveOwnedScene({
        userId: OWNER,
        input: { name: "Scene A", data, categories: ["Shared"] },
      }),
      saveOwnedScene({
        userId: OWNER,
        input: { name: "Scene B", data, categories: ["Shared"] },
      }),
    ]);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");

    const categories = await testDb
      .select()
      .from(schema.category)
      .where(eq(schema.category.userId, OWNER));
    expect(categories).toHaveLength(1);
    expect(categories[0]?.name).toBe("Shared");

    const mappings = await testDb
      .select({ categoryId: schema.sceneCategory.categoryId })
      .from(schema.sceneCategory);
    expect(mappings).toHaveLength(2);
    expect(mappings.every((row) => row.categoryId === categories[0]?.id)).toBe(
      true,
    );
  });

  it("a save whose category already exists reuses the existing row", async () => {
    const data = await emptySceneData();
    const seeded = await saveOwnedScene({
      userId: OWNER,
      input: { name: "Scene A", data, categories: ["Design"] },
    });
    expect(seeded.status).toBe("success");

    const repeat = await saveOwnedScene({
      userId: OWNER,
      input: { name: "Scene B", data, categories: ["Design", "Fresh"] },
    });
    expect(repeat.status).toBe("success");

    const categories = await testDb
      .select({ name: schema.category.name })
      .from(schema.category)
      .where(eq(schema.category.userId, OWNER));
    expect(categories.map((row) => row.name).sort()).toEqual([
      "Design",
      "Fresh",
    ]);
  });
});
