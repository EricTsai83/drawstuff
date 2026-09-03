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
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });

const OWNER = "owner";
const INTRUDER = "intruder";

function callerFor(userId: string) {
  return createCaller({
    db: testDb,
    headers: new Headers(),
    auth: { session: { id: `session-${userId}` }, user: { id: userId } },
  } as unknown as TRPCContext);
}

let sceneId: string;

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});
afterAll(() => client.close());
beforeEach(async () => {
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: INTRUDER, name: "Intruder", email: "intruder@example.com" },
  ]);
  const [row] = await testDb
    .insert(schema.scene)
    .values({ userId: OWNER, name: "Mine", sceneData: "stub" })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("scene insert failed");
  sceneId = row.id;
});

async function sceneRow() {
  const [row] = await testDb
    .select({ name: schema.scene.name, isArchived: schema.scene.isArchived })
    .from(schema.scene)
    .where(eq(schema.scene.id, sceneId));
  return row;
}

describe("scene router ownership predicates", () => {
  // 非擁有者看到的錯誤與「不存在」相同：ownership 是 WHERE 子句的一部分，
  // 所以既不會改到別人的列，也不會揭露該 scene 是否存在。
  it("refuses to rename another user's scene", async () => {
    await expect(
      callerFor(INTRUDER).scene.renameScene({ id: sceneId, name: "Stolen" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await sceneRow()).toMatchObject({ name: "Mine" });

    await expect(
      callerFor(OWNER).scene.renameScene({ id: sceneId, name: "Renamed" }),
    ).resolves.toMatchObject({ id: sceneId });
  });

  it("refuses to archive another user's scene", async () => {
    await expect(
      callerFor(INTRUDER).scene.archive({ id: sceneId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await sceneRow()).toMatchObject({ isArchived: false });

    await expect(
      callerFor(OWNER).scene.archive({ id: sceneId, expectedRevision: 1 }),
    ).resolves.toMatchObject({ id: sceneId });
  });
});
