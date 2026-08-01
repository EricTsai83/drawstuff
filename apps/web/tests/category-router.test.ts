// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "@/server/db/schema";
import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import { categoryNameSchema } from "@/lib/schemas/category";
import { saveSceneSchema } from "@/lib/schemas/scene";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });

const USER_A = "user-a";
const USER_B = "user-b";

function callerFor(userId: string) {
  const ctx = {
    db: testDb,
    headers: new Headers(),
    auth: {
      session: { id: `session-${userId}` },
      user: { id: userId },
    },
  } as unknown as TRPCContext;
  return createCaller(ctx);
}

async function createScene(userId: string, name: string) {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name, userId, sceneData: "stub" })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});

beforeEach(async () => {
  await testDb.delete(schema.sceneCategory);
  await testDb.delete(schema.category);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: USER_A, name: "User A", email: "a@example.com" },
    { id: USER_B, name: "User B", email: "b@example.com" },
  ]);
});

describe("categoryNameSchema", () => {
  it("trims and accepts a normal name", () => {
    expect(categoryNameSchema.parse("  Math  ")).toBe("Math");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(categoryNameSchema.safeParse("").success).toBe(false);
    expect(categoryNameSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects names over the character limit", () => {
    expect(categoryNameSchema.safeParse("x".repeat(101)).success).toBe(false);
    expect(categoryNameSchema.safeParse("x".repeat(100)).success).toBe(true);
  });

  it("accepts multibyte names within limits and rejects oversized input", () => {
    // 100 個 3-byte 中文字 = 300 bytes，通過 byte 與字元上限
    expect(categoryNameSchema.safeParse("中".repeat(100)).success).toBe(true);
    // 200 個 4-byte emoji = 800 bytes，先被 byte 上限擋下
    expect(categoryNameSchema.safeParse("🐰".repeat(200)).success).toBe(false);
  });

  it("applies the same limits to saveScene's name-based category path", () => {
    const base = { name: "Scene", data: "{}" };
    expect(
      saveSceneSchema.safeParse({ ...base, categories: ["Design"] }).success,
    ).toBe(true);
    expect(
      saveSceneSchema.safeParse({ ...base, categories: ["🐰".repeat(200)] })
        .success,
    ).toBe(false);
    expect(
      saveSceneSchema.safeParse({ ...base, categories: ["x".repeat(101)] })
        .success,
    ).toBe(false);
  });
});

describe("category router", () => {
  it("creates and lists categories scoped to the user", async () => {
    const callerA = callerFor(USER_A);
    const callerB = callerFor(USER_B);

    await callerA.category.create({ name: "Design" });
    await callerA.category.create({ name: "Algebra" });
    await callerB.category.create({ name: "Design" }); // 同名但屬於 B，允許

    const listA = await callerA.category.list();
    expect(listA.map((c) => c.name)).toEqual(["Algebra", "Design"]);
    expect(listA.every((c) => c.sceneCount === 0)).toBe(true);

    const listB = await callerB.category.list();
    expect(listB.map((c) => c.name)).toEqual(["Design"]);
  });

  it("rejects duplicate category names for the same user", async () => {
    const caller = callerFor(USER_A);
    await caller.category.create({ name: "Design" });
    await expect(caller.category.create({ name: "Design" })).rejects.toThrow(
      "Category already exists",
    );
  });

  it("renames a category and rejects renaming to an existing name", async () => {
    const caller = callerFor(USER_A);
    const created = await caller.category.create({ name: "Old" });
    await caller.category.create({ name: "Taken" });

    const renamed = await caller.category.rename({
      id: created.id,
      name: "New",
    });
    expect(renamed.name).toBe("New");

    await expect(
      caller.category.rename({ id: created.id, name: "Taken" }),
    ).rejects.toThrow("Category already exists");
  });

  it("does not allow renaming or deleting another user's category", async () => {
    const callerA = callerFor(USER_A);
    const callerB = callerFor(USER_B);
    const created = await callerA.category.create({ name: "Private" });

    await expect(
      callerB.category.rename({ id: created.id, name: "Hijacked" }),
    ).rejects.toThrow("Category not found");
    await expect(callerB.category.delete({ id: created.id })).rejects.toThrow(
      "Category not found",
    );

    const listA = await callerA.category.list();
    expect(listA.map((c) => c.name)).toEqual(["Private"]);
  });

  it("assigns and unassigns categories, updating scene counts", async () => {
    const caller = callerFor(USER_A);
    const created = await caller.category.create({ name: "Design" });
    const sceneId = await createScene(USER_A, "Scene 1");

    await caller.category.assignToScene({ sceneId, categoryId: created.id });
    // 冪等：重複指派不報錯
    await caller.category.assignToScene({ sceneId, categoryId: created.id });

    let list = await caller.category.list();
    expect(list[0]?.sceneCount).toBe(1);

    await caller.category.unassignFromScene({
      sceneId,
      categoryId: created.id,
    });
    list = await caller.category.list();
    expect(list[0]?.sceneCount).toBe(0);
  });

  it("rejects assignment to a scene or category the user does not own", async () => {
    const callerA = callerFor(USER_A);
    const callerB = callerFor(USER_B);
    const categoryA = await callerA.category.create({ name: "Design" });
    const categoryB = await callerB.category.create({ name: "Design" });
    const sceneA = await createScene(USER_A, "Scene A");

    await expect(
      callerB.category.assignToScene({
        sceneId: sceneA,
        categoryId: categoryB.id,
      }),
    ).rejects.toThrow("Invalid scene");

    await expect(
      callerA.category.assignToScene({
        sceneId: sceneA,
        categoryId: categoryB.id,
      }),
    ).rejects.toThrow("Invalid category");

    await expect(
      callerB.category.unassignFromScene({
        sceneId: sceneA,
        categoryId: categoryA.id,
      }),
    ).rejects.toThrow("Invalid scene");

    // 自己的 scene + 別人的 category 也必須被拒絕
    await expect(
      callerA.category.unassignFromScene({
        sceneId: sceneA,
        categoryId: categoryB.id,
      }),
    ).rejects.toThrow("Invalid category");
  });

  it("deleting a category removes its scene assignments but keeps scenes", async () => {
    const caller = callerFor(USER_A);
    const created = await caller.category.create({ name: "Design" });
    const sceneId = await createScene(USER_A, "Scene 1");
    await caller.category.assignToScene({ sceneId, categoryId: created.id });

    await caller.category.delete({ id: created.id });

    const mappings = await testDb.select().from(schema.sceneCategory);
    expect(mappings).toHaveLength(0);
    const scenes = await testDb.select().from(schema.scene);
    expect(scenes).toHaveLength(1);
  });
});

describe("getUserScenesInfinite category filter", () => {
  it("filters scenes by categoryId and returns category ids and names", async () => {
    const caller = callerFor(USER_A);
    const design = await caller.category.create({ name: "Design" });
    const sceneWith = await createScene(USER_A, "Tagged scene");
    const sceneWithout = await createScene(USER_A, "Untagged scene");
    await caller.category.assignToScene({
      sceneId: sceneWith,
      categoryId: design.id,
    });

    const all = await caller.scene.getUserScenesInfinite({ limit: 10 });
    expect(all.items.map((item) => item.id).sort()).toEqual(
      [sceneWith, sceneWithout].sort(),
    );

    const filtered = await caller.scene.getUserScenesInfinite({
      limit: 10,
      categoryId: design.id,
    });
    expect(filtered.items.map((item) => item.id)).toEqual([sceneWith]);
    expect(filtered.items[0]?.categories).toEqual([
      { id: design.id, name: "Design" },
    ]);
  });

  it("combines category filter with search", async () => {
    const caller = callerFor(USER_A);
    const design = await caller.category.create({ name: "Design" });
    const matching = await createScene(USER_A, "Poster draft");
    const otherTagged = await createScene(USER_A, "Meeting notes");
    await caller.category.assignToScene({
      sceneId: matching,
      categoryId: design.id,
    });
    await caller.category.assignToScene({
      sceneId: otherTagged,
      categoryId: design.id,
    });

    const result = await caller.scene.getUserScenesInfinite({
      limit: 10,
      categoryId: design.id,
      search: "poster",
    });
    expect(result.items.map((item) => item.id)).toEqual([matching]);
  });

  it("does not leak another user's scenes through categoryId", async () => {
    const callerA = callerFor(USER_A);
    const callerB = callerFor(USER_B);
    const categoryA = await callerA.category.create({ name: "Design" });
    const sceneA = await createScene(USER_A, "Scene A");
    await callerA.category.assignToScene({
      sceneId: sceneA,
      categoryId: categoryA.id,
    });

    const result = await callerB.scene.getUserScenesInfinite({
      limit: 10,
      categoryId: categoryA.id,
    });
    expect(result.items).toHaveLength(0);
  });
});
