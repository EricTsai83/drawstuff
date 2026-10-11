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

import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import { registerTestDatabase } from "./support/pglite-db";
import { testCaller } from "./support/trpc-caller";

registerTestDatabase({ pgClient, testDb });

const admin = () => testCaller(testDb, "admin-user").admin;

beforeEach(async () => {
  await testDb.delete(schema.adminAuditEvent);
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.fileRecord);
  await testDb.delete(schema.sharedScene);
  await testDb.delete(schema.collaborationCreationFence);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.session);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.adminGrant);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: "admin-user", name: "Admin", email: "admin@example.com" },
    { id: "target", name: "Target", email: "target@example.com" },
  ]);
  await testDb.insert(schema.adminGrant).values({
    userId: "admin-user",
    role: "operator",
    grantSource: "bootstrap",
  });
});

describe("admin investigation", () => {
  it("reports an account's footprint and takes its content down", async () => {
    const [published] = await testDb
      .insert(schema.scene)
      .values({
        userId: "target",
        name: "Public",
        isPublished: true,
        publishedSlug: "public-slug",
        publishedAt: new Date(),
      })
      .returning({ id: schema.scene.id });
    if (!published) throw new Error("scene insert failed");
    await testDb.insert(schema.fileRecord).values({
      sceneId: published.id,
      ownerId: "target",
      utFileKey: "image-key",
      excalidrawFileId: "file-1",
      size: 2048,
      url: "https://example.com/image",
    });
    await testDb.insert(schema.sharedScene).values({
      sharedSceneId: "shared-1",
      ownerId: "target",
      compressedData: Buffer.from("abcd"),
    });
    await testDb.insert(schema.fileRecord).values({
      sharedSceneId: "shared-1",
      ownerId: "target",
      utFileKey: "shared-key",
      excalidrawFileId: "file-2",
      size: 100,
      url: "https://example.com/shared",
    });
    await testDb.insert(schema.session).values({
      id: "session-target",
      token: "token-target",
      userId: "target",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const footprint = await admin().userFootprint({ userId: "target" });
    expect(footprint.usage).toMatchObject({
      imageFiles: 2,
      imageBytes: 2148,
      sharedLinks: 1,
      sharedLinkBytes: 4,
    });
    expect(footprint.sessions).toBe(1);
    expect(footprint.published.map((scene) => scene.publishedSlug)).toEqual([
      "public-slug",
    ]);
    expect(footprint.sharedLinks.map((link) => link.sharedSceneId)).toEqual([
      "shared-1",
    ]);

    await expect(
      admin().revokeSessions({
        userId: "admin-user",
        confirmUserId: "admin-user",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin().revokeSessions({ userId: "target", confirmUserId: "target" }),
    ).resolves.toEqual({ revoked: 1 });

    await expect(
      admin().unpublishScene({ sceneId: published.id }),
    ).resolves.toEqual({ id: published.id });
    const unpublished = await testDb.query.scene.findFirst({
      where: eq(schema.scene.id, published.id),
    });
    expect(unpublished).toMatchObject({
      isPublished: false,
      publishedSlug: null,
    });

    await expect(
      admin().deleteSharedLink({ sharedSceneId: "shared-1" }),
    ).resolves.toEqual({ found: true, enqueued: 1 });
    expect(await testDb.select().from(schema.sharedScene)).toEqual([]);
    expect(
      (await testDb.select().from(schema.deferredFileCleanup)).map(
        (task) => task.utFileKey,
      ),
    ).toEqual(["shared-key"]);
    await expect(
      admin().deleteSharedLink({ sharedSceneId: "shared-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const actions = (
      await admin().recentAuditEvents({ targetId: "target", limit: 30 })
    ).map((event) => event.action);
    expect(actions).toEqual(["revoke-sessions"]);
    expect(
      (
        await admin().recentAuditEvents({
          action: "unpublish-scene",
          limit: 30,
        })
      ).length,
    ).toBe(1);
  });

  it("looks up a room, including one only its fence remembers", async () => {
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-live",
      ownerId: "target",
      status: "ready",
      storageState: "ready",
    });
    await testDb.insert(schema.collaborationRoomMember).values({
      roomId: "room-live",
      userId: "target",
      role: "owner",
      access: "owned",
    });
    const live = await admin().getRoom({ roomId: "room-live" });
    expect(live.room).toMatchObject({ status: "ready", ownerId: "target" });
    expect(live.members?.map((member) => member.userId)).toEqual(["target"]);

    await testDb
      .insert(schema.collaborationCreationFence)
      .values({ roomId: "room-gone", ended: true });
    await expect(admin().getRoom({ roomId: "room-gone" })).resolves.toEqual({
      room: null,
      fence: { roomId: "room-gone", ended: true },
    });
  });

  it("filters the user list to administrators", async () => {
    const operators = await admin().listUsers({
      search: "",
      limit: 25,
      operatorsOnly: true,
    });
    expect(operators.map((target) => target.id)).toEqual(["admin-user"]);
  });
});
