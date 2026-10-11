// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/collab/lifecycle-gateway", () => ({
  callLifecycleGateway: () => Promise.reject(new Error("unexpected")),
}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: () => Promise.resolve(),
  rateLimitMetadataOf: () => null,
}));
vi.mock("@/env", () => ({
  env: { COLLAB_CONTROL_URL: "http://127.0.0.1:3105" },
}));

const { pgClient, testDb } = await vi.hoisted(async () => {
  const { createTestDatabase } = await import("./support/pglite-db");
  return createTestDatabase();
});
vi.mock("@/server/db/index", () => ({ db: testDb }));

import * as schema from "@/server/db/schema";
import {
  assertWithinQuota,
  QUOTA_DEFAULTS,
  QuotaExceededError,
  readQuotas,
  writeQuota,
} from "@/server/quota";
import { createOwnedSceneDraft } from "@/server/scene/save-owned-scene";
import type { Database } from "@/server/collab/rooms";
import { registerTestDatabase } from "./support/pglite-db";
import { testCaller } from "./support/trpc-caller";

registerTestDatabase({ pgClient, testDb });

const db = testDb as unknown as Database;
const admin = () => testCaller(testDb, "admin-user").admin;

beforeEach(async () => {
  await testDb.delete(schema.opsSetting);
  await testDb.delete(schema.adminAuditEvent);
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.sharedScene);
  await testDb.delete(schema.collaborationAsset);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.adminGrant);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: "admin-user", name: "Admin", email: "admin@example.com" },
    { id: "owner", name: "Owner", email: "owner@example.com" },
  ]);
  await testDb.insert(schema.adminGrant).values({
    userId: "admin-user",
    role: "operator",
    grantSource: "bootstrap",
  });
  // Every write in these tests invalidates the per-instance cache.
  await writeQuota(db, "scenes", QUOTA_DEFAULTS.scenes, "test");
});

describe("per-account quotas", () => {
  it("refuses a write that would pass a cap, using console overrides", async () => {
    await writeQuota(db, "scenes", 1, "admin-user");
    expect((await readQuotas(db)).scenes).toBe(1);

    await expect(
      createOwnedSceneDraft({ userId: "owner", input: { name: "One" } }),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      createOwnedSceneDraft({ userId: "owner", input: { name: "Two" } }),
    ).resolves.toEqual({
      status: "quota_exceeded",
      message: "Storage limit reached for this account.",
    });
  });

  it("counts scene, shared-link and room images together", async () => {
    await writeQuota(db, "imageBytes", 1_000, "admin-user");
    await testDb
      .insert(schema.sharedScene)
      .values({ sharedSceneId: "shared-1", ownerId: "owner" });
    await testDb.insert(schema.fileRecord).values({
      sharedSceneId: "shared-1",
      ownerId: "owner",
      utFileKey: "key-1",
      excalidrawFileId: "file-1",
      size: 600,
      url: "https://example.com/1",
    });
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-1",
      ownerId: "owner",
      status: "ready",
    });
    await testDb.insert(schema.collaborationAsset).values({
      roomId: "room-1",
      excalidrawFileId: "a".repeat(40),
      utFileKey: "room-key",
      url: "https://example.com/room",
      byteLength: 300,
      registeredBy: "owner",
    });

    await expect(
      assertWithinQuota(db, "owner", "imageBytes", 100),
    ).resolves.toBeUndefined();
    await expect(
      assertWithinQuota(db, "owner", "imageBytes", 101),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("counts live rooms only", async () => {
    await writeQuota(db, "activeRooms", 1, "admin-user");
    await testDb.insert(schema.collaborationRoom).values([
      { roomId: "room-live", ownerId: "owner", status: "ready" },
      { roomId: "room-ended", ownerId: "owner", status: "ended" },
    ]);
    await expect(
      assertWithinQuota(db, "owner", "activeRooms", 1),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await testDb.delete(schema.collaborationRoom);
    await expect(
      assertWithinQuota(db, "owner", "activeRooms", 1),
    ).resolves.toBeUndefined();
  });

  it("lets an operator change a cap and see each account against it", async () => {
    await expect(
      admin().setQuota({ name: "activeRooms", value: 3 }),
    ).resolves.toEqual({ name: "activeRooms", value: 3 });
    const controls = await admin().opsControls();
    expect(controls.quotas).toContainEqual({
      name: "activeRooms",
      value: 3,
      defaultValue: QUOTA_DEFAULTS.activeRooms,
    });
    const footprint = await admin().userFootprint({ userId: "owner" });
    expect(footprint.quota.caps.activeRooms).toBe(3);
    expect(footprint.quota.usage.activeRooms).toBe(0);
    const [audit] = await testDb.select().from(schema.adminAuditEvent);
    expect(audit).toMatchObject({
      action: "set-quota",
      targetId: "quota:activeRooms",
      status: "succeeded",
    });
  });
});
