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

const { relayCalls, storageDeletes } = vi.hoisted(() => ({
  relayCalls: [] as unknown[],
  storageDeletes: [] as string[],
}));
vi.mock("@/server/collab/relay-control", () => ({
  pushRelayRoomControl: (params: unknown) => {
    relayCalls.push(params);
    return Promise.resolve({ enforced: true, closedSessions: 1 });
  },
}));
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles(keys: string[]) {
      storageDeletes.push(...keys);
      return keys.includes("fail-key")
        ? Promise.reject(new Error("storage unavailable"))
        : Promise.resolve({ success: true });
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

function callerFor(userId: string | null) {
  return createCaller({
    db: testDb,
    headers: new Headers(),
    auth: userId
      ? { session: { id: `session-${userId}` }, user: { id: userId } }
      : null,
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
  relayCalls.length = 0;
  storageDeletes.length = 0;
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.adminAuditEvent);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: "admin-user", name: "Admin", email: "admin@example.com" },
    { id: "target-user", name: "Target", email: "target@example.com" },
    { id: "other-user", name: "Other", email: "other@example.com" },
  ]);
  await testDb.insert(schema.adminGrant).values({
    userId: "admin-user",
    role: "operator",
    grantSource: "bootstrap",
  });
});

describe("admin data retirement", () => {
  it("exposes a fail-closed navigation hint without granting admin access", async () => {
    await expect(
      callerFor("admin-user").admin.access({ userId: "admin-user" }),
    ).resolves.toEqual({ isOperator: true });
    await expect(
      callerFor("other-user").admin.access({ userId: "other-user" }),
    ).resolves.toEqual({ isOperator: false });
    await expect(
      callerFor("other-user").admin.access({ userId: "admin-user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor(null).admin.access({ userId: "admin-user" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    await expect(
      callerFor(null).admin.endRoom({ roomId: "missing" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      callerFor("other-user").admin.endRoom({ roomId: "missing" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await testDb.select().from(schema.adminAuditEvent)).toEqual([]);
  });

  it("rejects a revoked operator grant", async () => {
    await testDb
      .update(schema.adminGrant)
      .set({ revokedAt: new Date() })
      .where(eq(schema.adminGrant.userId, "admin-user"));
    await expect(
      callerFor("admin-user").admin.endRoom({ roomId: "missing" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("exposes operator-only overview, user search, detail, and audit queries", async () => {
    const [targetScene] = await testDb
      .insert(schema.scene)
      .values({ userId: "target-user", name: "Target scene" })
      .returning({ id: schema.scene.id });
    if (!targetScene) throw new Error("scene insert failed");
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-overview",
      sceneId: targetScene.id,
      ownerId: "target-user",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const admin = callerFor("admin-user").admin;
    await expect(admin.overview()).resolves.toEqual({
      userCount: 3,
      sceneCount: 1,
      activeRoomCount: 1,
      pendingCleanupCount: 0,
    });

    const users = await admin.listUsers({
      search: "target@example.com",
      limit: 25,
    });
    expect(users).toEqual([
      expect.objectContaining({
        id: "target-user",
        sceneCount: 1,
        activeRoomCount: 1,
        isOperator: false,
      }),
    ]);

    await expect(
      admin.getUser({ userId: "target-user" }),
    ).resolves.toMatchObject({
      user: { id: "target-user" },
      scenes: [{ id: targetScene.id }],
      rooms: [{ roomId: "room-overview", status: "active" }],
      grant: undefined,
    });

    await admin.endRoom({ roomId: "room-overview" });
    await expect(admin.recentAuditEvents({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        actorUserId: "admin-user",
        actorEmail: "admin@example.com",
        action: "end-room",
        status: "succeeded",
      }),
    ]);
    await expect(
      callerFor("other-user").admin.overview(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("grants and revokes another verified Google operator with durable audit", async () => {
    await testDb
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, "other-user"));
    await testDb.insert(schema.account).values({
      id: "account-other",
      accountId: "google-other",
      providerId: "google",
      userId: "other-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      callerFor("admin-user").admin.grantOperator({
        userId: "other-user",
        confirmUserId: "other-user",
      }),
    ).resolves.toEqual({ granted: true, alreadyActive: false });
    await expect(
      callerFor("other-user").admin.endRoom({ roomId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor("admin-user").admin.revokeOperator({
        userId: "other-user",
        confirmUserId: "other-user",
      }),
    ).resolves.toEqual({ revoked: true });
    await expect(
      callerFor("other-user").admin.endRoom({ roomId: "missing" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(
      (await testDb.select().from(schema.adminAuditEvent)).map(
        ({ action, status }) => ({ action, status }),
      ),
    ).toEqual([
      { action: "grant-admin", status: "succeeded" },
      { action: "end-room", status: "failed" },
      { action: "revoke-admin", status: "succeeded" },
    ]);
  });

  it("retires another user's scene and durably queues failed object cleanup", async () => {
    const [target] = await testDb
      .insert(schema.scene)
      .values({
        userId: "target-user",
        name: "Target",
        sceneData: "stub",
        thumbnailFileKey: "fail-key",
      })
      .returning({ id: schema.scene.id });
    if (!target) throw new Error("scene insert failed");
    await testDb.insert(schema.fileRecord).values({
      sceneId: target.id,
      ownerId: "target-user",
      utFileKey: "asset-key",
      excalidrawFileId: "asset-id",
      size: 1,
      url: "https://example.com/a",
    });

    await expect(
      callerFor("admin-user").admin.retireScene({ sceneId: target.id }),
    ).resolves.toMatchObject({
      found: true,
      deletedObjects: 1,
      enqueuedObjects: 1,
    });
    expect(await testDb.select().from(schema.scene)).toEqual([]);
    expect(
      (await testDb.select().from(schema.deferredFileCleanup))[0],
    ).toMatchObject({
      utFileKey: "fail-key",
      reason: "delete-scene",
      status: "pending",
    });
    expect(await testDb.select().from(schema.adminAuditEvent)).toEqual([
      expect.objectContaining({
        actorUserId: "admin-user",
        targetId: target.id,
        status: "succeeded",
      }),
    ]);
  });

  it("ends any room, advances authorization, and pushes relay control", async () => {
    const [target] = await testDb
      .insert(schema.scene)
      .values({ userId: "target-user", name: "Target", sceneData: "stub" })
      .returning({ id: schema.scene.id });
    if (!target) throw new Error("scene insert failed");
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-target",
      sceneId: target.id,
      ownerId: "target-user",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      callerFor("admin-user").admin.endRoom({ roomId: "room-target" }),
    ).resolves.toMatchObject({ found: true, relayEnforced: true });
    const room = await testDb.query.collaborationRoom.findFirst({
      where: eq(schema.collaborationRoom.roomId, "room-target"),
    });
    expect(room).toMatchObject({ status: "ended", authRevision: 2 });
    expect(relayCalls).toEqual([
      expect.objectContaining({
        action: "end-room",
        roomId: "room-target",
        authRevision: 2,
      }),
    ]);
  });

  it("retires an account through room and scene lifecycles, then cascades auth rows", async () => {
    await testDb.insert(schema.session).values({
      id: "session-target",
      token: "token-target",
      userId: "target-user",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await testDb.insert(schema.account).values({
      id: "account-target",
      accountId: "google-target",
      providerId: "google",
      userId: "target-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [target] = await testDb
      .insert(schema.scene)
      .values({ userId: "target-user", name: "Target", sceneData: "stub" })
      .returning({ id: schema.scene.id });
    if (!target) throw new Error("scene insert failed");
    await testDb.insert(schema.collaborationRoom).values({
      roomId: "room-account",
      sceneId: target.id,
      ownerId: "target-user",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      callerFor("admin-user").admin.retireAccount({
        userId: "target-user",
        confirmUserId: "target-user",
      }),
    ).resolves.toMatchObject({ found: true, scenes: 1, rooms: 1 });
    expect(
      await testDb.query.user.findFirst({
        where: eq(schema.user.id, "target-user"),
      }),
    ).toBeUndefined();
    expect(await testDb.select().from(schema.session)).toEqual([]);
    expect(await testDb.select().from(schema.account)).toEqual([]);
    expect(await testDb.select().from(schema.collaborationRoom)).toEqual([]);
    expect(relayCalls).toHaveLength(1);
  });
});
