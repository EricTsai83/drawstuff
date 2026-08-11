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
import { bootstrapFirstAdmin } from "@/server/admin/bootstrap";
import { type Database } from "@/server/collab/rooms";
import * as schema from "@/server/db/schema";

const client = new PGlite();
const testDb = drizzle(client, { schema });
const bootstrapDb = testDb as unknown as Database;

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});
afterAll(() => client.close());
beforeEach(async () => {
  await testDb.delete(schema.adminAuditEvent);
  await testDb.delete(schema.user);
});

async function createGoogleUser(params: {
  id: string;
  email: string;
  verified?: boolean;
  provider?: string;
}) {
  await testDb.insert(schema.user).values({
    id: params.id,
    name: params.id,
    email: params.email,
    emailVerified: params.verified ?? true,
  });
  await testDb.insert(schema.account).values({
    id: `account-${params.id}`,
    accountId: `subject-${params.id}`,
    providerId: params.provider ?? "google",
    userId: params.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("first administrator bootstrap", () => {
  it("turns a verified Google identity into a durable ID-based grant", async () => {
    await createGoogleUser({ id: "operator-id", email: "Eric@Example.com" });
    await expect(
      bootstrapFirstAdmin({ db: bootstrapDb, email: " eric@example.com " }),
    ).resolves.toMatchObject({ status: "granted", userId: "operator-id" });

    expect(await testDb.select().from(schema.adminGrant)).toEqual([
      expect.objectContaining({
        userId: "operator-id",
        role: "operator",
        grantSource: "bootstrap",
        revokedAt: null,
      }),
    ]);
    expect(await testDb.select().from(schema.adminAuditEvent)).toEqual([
      expect.objectContaining({
        actorUserId: "operator-id",
        action: "grant-admin",
        targetId: "operator-id",
        status: "succeeded",
      }),
    ]);
  });

  it("is idempotent for the existing administrator", async () => {
    await createGoogleUser({ id: "operator-id", email: "eric@example.com" });
    await bootstrapFirstAdmin({ db: bootstrapDb, email: "eric@example.com" });
    await expect(
      bootstrapFirstAdmin({ db: bootstrapDb, email: "eric@example.com" }),
    ).resolves.toMatchObject({ status: "already-admin" });
    expect(await testDb.select().from(schema.adminGrant)).toHaveLength(1);
  });

  it("rejects unverified or non-Google identities", async () => {
    await createGoogleUser({
      id: "unverified",
      email: "unverified@example.com",
      verified: false,
    });
    await expect(
      bootstrapFirstAdmin({ db: bootstrapDb, email: "unverified@example.com" }),
    ).rejects.toThrow("not verified");

    await createGoogleUser({
      id: "github-user",
      email: "github@example.com",
      provider: "github",
    });
    await expect(
      bootstrapFirstAdmin({ db: bootstrapDb, email: "github@example.com" }),
    ).rejects.toThrow("not linked to Google");
  });

  it("closes bootstrap after the first active administrator", async () => {
    await createGoogleUser({ id: "first", email: "first@example.com" });
    await createGoogleUser({ id: "second", email: "second@example.com" });
    await bootstrapFirstAdmin({ db: bootstrapDb, email: "first@example.com" });
    await expect(
      bootstrapFirstAdmin({ db: bootstrapDb, email: "second@example.com" }),
    ).rejects.toThrow("Bootstrap is closed");
  });
});
