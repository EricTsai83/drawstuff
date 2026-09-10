import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll } from "vitest";

import * as schema from "@/server/db/schema";

export type TestDatabase = PgliteDatabase<typeof schema>;

export type TestDatabaseHandle = {
  pgClient: PGlite;
  testDb: TestDatabase;
};

/**
 * One in-memory PGlite behind the app's drizzle schema, with no tables yet.
 * Suites that mock `@/server/db/index` build this inside `vi.hoisted` so the
 * mock factory can hand out `testDb`; everything else uses `openTestDatabase`.
 */
export function createTestDatabase(): TestDatabaseHandle {
  const pgClient = new PGlite();
  return { pgClient, testDb: drizzle(pgClient, { schema }) };
}

/** Pushes the drizzle schema before the suite and closes PGlite after it. */
export function registerTestDatabase({
  pgClient,
  testDb,
}: TestDatabaseHandle): void {
  beforeAll(async () => {
    // PGlite speaks the same SQL as the postgres-js database the schema push
    // is typed against, so the same push API builds the test tables.
    const { apply } = await pushSchema(
      schema,
      testDb as unknown as Parameters<typeof pushSchema>[1],
    );
    await apply();
  });
  afterAll(() => pgClient.close());
}

/** A schema-pushed test database whose lifetime is the current suite. */
export function openTestDatabase(): TestDatabase {
  const handle = createTestDatabase();
  registerTestDatabase(handle);
  return handle.testDb;
}
