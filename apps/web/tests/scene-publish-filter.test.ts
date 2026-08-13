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

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "@/server/db/schema";
import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });

const USER_A = "user-a";

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

async function createScene(
  userId: string,
  name: string,
  options: { isPublished?: boolean } = {},
) {
  const [row] = await testDb
    .insert(schema.scene)
    .values({
      name,
      userId,
      sceneData: "stub",
      isPublished: options.isPublished ?? false,
    })
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

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb
    .insert(schema.user)
    .values([{ id: USER_A, name: "User A", email: "a@example.com" }]);
});

describe("scene.getUserScenesInfinite isPublished filter", () => {
  it("returns only published scenes when isPublished is true", async () => {
    await createScene(USER_A, "private-1");
    await createScene(USER_A, "private-2");
    await createScene(USER_A, "private-3");
    await createScene(USER_A, "public-1", { isPublished: true });

    const caller = callerFor(USER_A);
    const result = await caller.scene.getUserScenesInfinite({
      limit: 10,
      isPublished: true,
    });

    expect(result.items.map((item) => item.name)).toEqual(["public-1"]);
    // server 端已過濾：沒有下一頁，client 不需要為了湊滿畫面連環抓頁
    expect(result.nextCursor).toBeUndefined();
  });

  it("returns only private scenes when isPublished is false", async () => {
    await createScene(USER_A, "private-1");
    await createScene(USER_A, "public-1", { isPublished: true });

    const caller = callerFor(USER_A);
    const result = await caller.scene.getUserScenesInfinite({
      limit: 10,
      isPublished: false,
    });

    expect(result.items.map((item) => item.name)).toEqual(["private-1"]);
  });

  it("returns all scenes when isPublished is omitted", async () => {
    await createScene(USER_A, "private-1");
    await createScene(USER_A, "public-1", { isPublished: true });

    const caller = callerFor(USER_A);
    const result = await caller.scene.getUserScenesInfinite({ limit: 10 });

    expect(result.items).toHaveLength(2);
  });

  it("treats LIKE wildcards in search as literal characters", async () => {
    await createScene(USER_A, "foo_bar");
    await createScene(USER_A, "fooxbar");
    await createScene(USER_A, "100% done");

    const caller = callerFor(USER_A);
    const underscore = await caller.scene.getUserScenesInfinite({
      limit: 10,
      search: "foo_bar",
    });
    expect(underscore.items.map((item) => item.name)).toEqual(["foo_bar"]);

    const percent = await caller.scene.getUserScenesInfinite({
      limit: 10,
      search: "100%",
    });
    expect(percent.items.map((item) => item.name)).toEqual(["100% done"]);
  });

  it("paginates within the published subset only", async () => {
    for (let i = 0; i < 12; i++) {
      await createScene(USER_A, `private-${i}`);
    }
    await createScene(USER_A, "public-1", { isPublished: true });
    await createScene(USER_A, "public-2", { isPublished: true });

    const caller = callerFor(USER_A);
    const firstPage = await caller.scene.getUserScenesInfinite({
      limit: 1,
      isPublished: true,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await caller.scene.getUserScenesInfinite({
      limit: 1,
      isPublished: true,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(
      [...firstPage.items, ...secondPage.items].every(
        (item) => item.isPublished,
      ),
    ).toBe(true);
  });
});
