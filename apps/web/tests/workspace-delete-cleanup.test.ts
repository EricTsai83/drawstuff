// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: () => Promise.resolve(),
  rateLimitMetadataOf: () => null,
}));
vi.mock("@/env", () => ({
  env: {
    COLLAB_JOIN_TOKEN_SECRET: "web-test-room-token-secret-0123456789",
    COLLAB_RELAY_CONTROL_URL: "http://127.0.0.1:3105",
  },
}));
vi.mock("@/server/collab/relay-control", () => ({
  pushRelayRoomControl: () =>
    Promise.resolve({ enforced: true, closedSessions: 0 }),
}));
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles() {
      return Promise.resolve({ success: true });
    }
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import * as schema from "@/server/db/schema";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;
const client = new PGlite();
const testDb = drizzle(client, { schema });

function callerFor(userId: string) {
  return createCaller({
    db: testDb,
    headers: new Headers(),
    auth: { session: { id: `session-${userId}` }, user: { id: userId } },
  } as unknown as TRPCContext);
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});
afterAll(() => client.close());
beforeEach(async () => {
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.userLastActiveWorkspace);
  await testDb.delete(schema.userDefaultWorkspace);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: "owner-user", name: "Owner", email: "owner@example.com" },
    { id: "other-user", name: "Other", email: "other@example.com" },
  ]);
});

async function seedWorkspaces() {
  const [defaultWorkspace] = await testDb
    .insert(schema.workspace)
    .values({ name: "Default", userId: "owner-user" })
    .returning({ id: schema.workspace.id });
  const [doomedWorkspace] = await testDb
    .insert(schema.workspace)
    .values({ name: "Doomed", userId: "owner-user" })
    .returning({ id: schema.workspace.id });
  if (!defaultWorkspace || !doomedWorkspace)
    throw new Error("workspace insert failed");
  await testDb.insert(schema.userDefaultWorkspace).values({
    userId: "owner-user",
    workspaceId: defaultWorkspace.id,
  });
  return { defaultId: defaultWorkspace.id, doomedId: doomedWorkspace.id };
}

describe("workspace.delete storage lifecycle", () => {
  it("queues every contained storage key in the same transaction as the cascade", async () => {
    const { defaultId, doomedId } = await seedWorkspaces();
    await testDb.insert(schema.userLastActiveWorkspace).values({
      userId: "owner-user",
      workspaceId: doomedId,
      updatedAt: new Date(),
    });
    const [doomedScene] = await testDb
      .insert(schema.scene)
      .values({
        name: "Doomed scene",
        userId: "owner-user",
        workspaceId: doomedId,
        thumbnailFileKey: "thumb-key",
      })
      .returning({ id: schema.scene.id });
    if (!doomedScene) throw new Error("scene insert failed");
    await testDb.insert(schema.fileRecord).values({
      sceneId: doomedScene.id,
      ownerId: "owner-user",
      utFileKey: "asset-key",
      excalidrawFileId: "asset-id",
      size: 1,
      url: "https://example.com/a",
    });
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-doomed",
      sceneId: doomedScene.id,
      ownerId: "owner-user",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await testDb.insert(schema.collaborationAsset).values({
      roomId: "room-doomed",
      authGeneration: 1,
      excalidrawFileId: "a".repeat(40),
      cryptoVersion: 1,
      utFileKey: "room-asset-key",
      url: "https://example.com/room-asset",
      byteLength: 16,
    });
    // A scene in another workspace must stay untouched.
    await testDb.insert(schema.scene).values({
      name: "Kept scene",
      userId: "owner-user",
      workspaceId: defaultId,
      thumbnailFileKey: "kept-thumb-key",
    });

    await expect(
      callerFor("owner-user").workspace.delete({ id: doomedId }),
    ).resolves.toEqual({ success: true });

    expect(
      await testDb
        .select()
        .from(schema.workspace)
        .where(eq(schema.workspace.id, doomedId)),
    ).toEqual([]);
    expect(await testDb.select().from(schema.fileRecord)).toEqual([]);
    expect(await testDb.select().from(schema.collaborationAsset)).toEqual([]);
    const scenes = await testDb.select().from(schema.scene);
    expect(scenes.map((row) => row.name)).toEqual(["Kept scene"]);
    const queued = await testDb.select().from(schema.deferredFileCleanup);
    expect(
      queued.map((task) => [task.utFileKey, task.reason, task.status]).sort(),
    ).toEqual([
      ["asset-key", "delete-workspace", "pending"],
      ["room-asset-key", "delete-workspace", "pending"],
      ["thumb-key", "delete-workspace", "pending"],
    ]);
    // lastActive was re-pointed at the default workspace before the delete.
    expect(
      await testDb.select().from(schema.userLastActiveWorkspace),
    ).toEqual([
      expect.objectContaining({
        userId: "owner-user",
        workspaceId: defaultId,
      }),
    ]);
  });

  it("still refuses to delete the default workspace or another user's workspace", async () => {
    const { defaultId, doomedId } = await seedWorkspaces();

    await expect(
      callerFor("owner-user").workspace.delete({ id: defaultId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor("other-user").workspace.delete({ id: doomedId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await testDb.select().from(schema.deferredFileCleanup)).toEqual([]);
  });
});
