import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const workflowMocks = vi.hoisted(() => ({
  saveOwnedScene: vi.fn(),
  getSceneOwnerId: vi.fn(),
  getSceneThumbnailKey: vi.fn(),
  getFileKeysBySceneIds: vi.fn(),
  enqueueDeferredCleanup: vi.fn(),
  deleteFiles: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/server/scene/save-owned-scene", () => ({
  saveOwnedScene: workflowMocks.saveOwnedScene,
}));

vi.mock("@/server/db/queries", () => ({
  QUERIES: {
    getSceneOwnerId: workflowMocks.getSceneOwnerId,
    getSceneThumbnailKey: workflowMocks.getSceneThumbnailKey,
    getFileKeysBySceneIds: workflowMocks.getFileKeysBySceneIds,
    enqueueDeferredCleanup: workflowMocks.enqueueDeferredCleanup,
  },
}));

vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles = workflowMocks.deleteFiles;
  },
}));

import { sceneRouter } from "@/server/api/routers/scene";

const userId = "user-phase-0";
const sceneId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

type CallerContext = Parameters<typeof sceneRouter.createCaller>[0];
type DirectCallerContext = Extract<CallerContext, { auth: unknown }>;

function createCaller(
  db: unknown,
  auth: DirectCallerContext["auth"] = {
    session: {
      id: "session-phase-0",
      userId,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      token: "test-token",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    user: {
      id: userId,
      name: "Phase Zero",
      email: "phase0@example.com",
      emailVerified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  },
) {
  return sceneRouter.createCaller({
    db,
    headers: new Headers(),
    auth,
  } as DirectCallerContext);
}

function createUpdateBuilder(result: unknown[]) {
  const returning = vi.fn(async () => result);
  const where = vi.fn((_predicate: unknown) => ({ returning }));
  const set = vi.fn((_values: unknown) => ({ where }));
  return { set, where, returning };
}

function expectSqlParams(
  predicate: unknown,
  expectedParams: readonly string[],
): void {
  expect(predicate).toBeInstanceOf(SQL);
  const query = new PgDialect().sqlToQuery(predicate as SQL);
  expect(query.params).toEqual(expect.arrayContaining([...expectedParams]));
}

function getWhereArgument(call: unknown): unknown {
  if (typeof call !== "object" || call === null || !("where" in call)) {
    throw new Error("Expected a Drizzle query options object with where");
  }
  return call.where;
}

describe("critical cloud scene workflow", () => {
  beforeEach(() => {
    Object.values(workflowMocks).forEach((mock) => mock.mockReset());
    workflowMocks.deleteFiles.mockResolvedValue(undefined);
    workflowMocks.enqueueDeferredCleanup.mockResolvedValue(undefined);
  });

  it("creates, saves, reloads, renames, moves, publishes, and deletes an owned scene", async () => {
    const storedScene = {
      id: sceneId,
      userId,
      workspaceId,
      name: "Saved scene",
      sceneData: "stable-compressed-payload",
      revision: 2,
    };
    const findScene = vi.fn(
      async (_options: unknown): Promise<unknown> => storedScene,
    );
    const findWorkspace = vi.fn(async (_options: unknown) => ({
      id: workspaceId,
    }));
    const update = vi.fn();
    const deleteWhere = vi.fn(async (_predicate: unknown) => undefined);
    const deleteScene = vi.fn(() => ({ where: deleteWhere }));
    const db = {
      query: {
        scene: { findFirst: findScene },
        workspace: { findFirst: findWorkspace },
      },
      update,
      delete: deleteScene,
    };
    const caller = createCaller(db);

    workflowMocks.saveOwnedScene
      .mockResolvedValueOnce({
        status: "success",
        data: {
          id: sceneId,
          action: "created",
          revision: 1,
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      })
      .mockResolvedValueOnce({
        status: "success",
        data: {
          id: sceneId,
          action: "updated",
          revision: 2,
          updatedAt: new Date("2026-07-01T00:01:00.000Z"),
        },
      });

    const created = await caller.saveScene({
      name: "Created scene",
      workspaceId,
      data: "stable-compressed-payload",
    });
    const saved = await caller.saveScene({
      id: sceneId,
      name: "Saved scene",
      workspaceId,
      expectedRevision: 1,
      data: "stable-compressed-payload",
    });
    const reloaded = await caller.getScene({ id: sceneId });

    expect(created).toMatchObject({ action: "created", revision: 1 });
    expect(saved).toMatchObject({ action: "updated", revision: 2 });
    expect(reloaded).toEqual(storedScene);
    expect(workflowMocks.saveOwnedScene).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId }),
    );
    expect(workflowMocks.saveOwnedScene).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId }),
    );
    expectSqlParams(getWhereArgument(findScene.mock.calls[0]?.[0]), [
      sceneId,
      userId,
    ]);

    const renameBuilder = createUpdateBuilder([{ id: sceneId, revision: 3 }]);
    update.mockReturnValueOnce(renameBuilder);
    const renamed = await caller.renameScene({
      id: sceneId,
      name: "Renamed scene",
    });
    expect(renamed).toEqual({ id: sceneId, revision: 3 });
    expect(renameBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed scene" }),
    );
    expectSqlParams(renameBuilder.where.mock.calls[0]?.[0], [sceneId, userId]);

    const moveBuilder = createUpdateBuilder([{ id: sceneId, revision: 4 }]);
    update.mockReturnValueOnce(moveBuilder);
    const moved = await caller.moveToWorkspace({ id: sceneId, workspaceId });
    expect(moved).toEqual({ id: sceneId, revision: 4 });
    expect(findWorkspace).toHaveBeenCalledOnce();
    expect(moveBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
    );
    expectSqlParams(getWhereArgument(findWorkspace.mock.calls[0]?.[0]), [
      workspaceId,
      userId,
    ]);
    expectSqlParams(moveBuilder.where.mock.calls[0]?.[0], [sceneId, userId]);

    findScene.mockResolvedValueOnce({
      id: sceneId,
      isPublished: false,
      publishedSlug: null,
    });
    const publishBuilder = createUpdateBuilder([
      { publishedSlug: "phase0slug12" },
    ]);
    update.mockReturnValueOnce(publishBuilder);
    const published = await caller.publish({ id: sceneId });
    expect(published).toEqual({
      slug: "phase0slug12",
      alreadyPublished: false,
    });
    expect(publishBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true }),
    );
    expectSqlParams(getWhereArgument(findScene.mock.calls[1]?.[0]), [
      sceneId,
      userId,
    ]);
    expectSqlParams(publishBuilder.where.mock.calls[0]?.[0], [sceneId, userId]);

    workflowMocks.getSceneOwnerId.mockResolvedValue(userId);
    workflowMocks.getSceneThumbnailKey.mockResolvedValue("thumbnail-key");
    workflowMocks.getFileKeysBySceneIds.mockResolvedValue([
      "asset-key",
      "asset-key",
    ]);
    const deleted = await caller.deleteScene({ id: sceneId });

    expect(deleted).toEqual({ success: true });
    expect(workflowMocks.deleteFiles).toHaveBeenCalledTimes(2);
    expect(workflowMocks.deleteFiles).toHaveBeenCalledWith(["asset-key"]);
    expect(workflowMocks.deleteFiles).toHaveBeenCalledWith(["thumbnail-key"]);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expectSqlParams(deleteWhere.mock.calls[0]?.[0], [sceneId, userId]);
  });

  it("rejects unauthenticated access before querying scene data", async () => {
    const findFirst = vi.fn();
    const caller = createCaller(
      {
        query: {
          scene: { findFirst },
        },
      },
      null,
    );

    await expect(caller.getScene({ id: sceneId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects moving a scene into another user's workspace", async () => {
    const update = vi.fn();
    const caller = createCaller({
      query: {
        workspace: {
          findFirst: vi.fn(async () => null),
        },
      },
      update,
    });

    await expect(
      caller.moveToWorkspace({ id: sceneId, workspaceId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects deleting another user's scene before touching storage or the database", async () => {
    workflowMocks.getSceneOwnerId.mockResolvedValue("another-user");
    const deleteScene = vi.fn();
    const caller = createCaller({ delete: deleteScene });

    await expect(caller.deleteScene({ id: sceneId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(workflowMocks.deleteFiles).not.toHaveBeenCalled();
    expect(deleteScene).not.toHaveBeenCalled();
  });

  it("queues failed UploadThing deletions before deleting the database scene", async () => {
    workflowMocks.getSceneOwnerId.mockResolvedValue(userId);
    workflowMocks.getSceneThumbnailKey.mockResolvedValue(null);
    workflowMocks.getFileKeysBySceneIds.mockResolvedValue(["orphaned-key"]);
    workflowMocks.deleteFiles.mockRejectedValue(new Error("storage offline"));
    const deleteWhere = vi.fn(async (_predicate: unknown) => undefined);
    const caller = createCaller({
      delete: vi.fn(() => ({ where: deleteWhere })),
    });

    await expect(caller.deleteScene({ id: sceneId })).resolves.toEqual({
      success: true,
    });
    expect(workflowMocks.enqueueDeferredCleanup).toHaveBeenCalledWith({
      utFileKey: "orphaned-key",
      reason: "delete-scene",
      context: { sceneId },
    });
    expect(deleteWhere).toHaveBeenCalledOnce();
    expectSqlParams(deleteWhere.mock.calls[0]?.[0], [sceneId, userId]);
    expect(
      workflowMocks.enqueueDeferredCleanup.mock.invocationCallOrder[0],
    ).toBeLessThan(deleteWhere.mock.invocationCallOrder[0]!);
  });
});
