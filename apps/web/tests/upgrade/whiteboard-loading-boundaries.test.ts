import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistedWhiteboardDocumentV2,
  migrateWhiteboardDocumentV2,
} from "@drawstuff/whiteboard/migration-v2";
import { serializeWhiteboardDocumentV3 } from "@drawstuff/whiteboard";
import { compressData } from "@/lib/encode";

const boundaryMocks = vi.hoisted(() => ({
  getOwnedScene: vi.fn(),
  getSharedScene: vi.fn(),
}));

vi.mock("@/trpc/client", () => ({
  getTrpcClient: () => ({
    scene: {
      getScene: {
        query: boundaryMocks.getOwnedScene,
      },
    },
    sharedScene: {
      getCompressedBySharedSceneId: {
        query: boundaryMocks.getSharedScene,
      },
    },
  }),
}));

import {
  importDataFromBackend,
  importSceneDataBySceneId,
} from "@/lib/import-data-from-db";

function createOwnedSource(): string {
  const v2 = createPersistedWhiteboardDocumentV2({
    elements: [
      {
        id: "owned-element",
        type: "image",
        isDeleted: false,
        fileId: "owned-asset",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        opacity: 100,
        roughness: 0,
        locked: false,
      },
    ],
    assets: {
      "owned-asset": {
        id: "owned-asset",
        dataURL: "data:image/png;base64,AA==",
        mimeType: "image/png",
        created: 1,
      },
      "deleted-asset": {
        id: "deleted-asset",
        dataURL: "data:image/png;base64,AA==",
        mimeType: "image/png",
        created: 2,
      },
    },
    state: {
      name: "Embedded name",
      theme: "dark",
      viewBackgroundColor: "#111111",
      gridSize: 16,
    },
  });
  return serializeWhiteboardDocumentV3(migrateWhiteboardDocumentV2(v2));
}

function createNonCanonicalSource(): string {
  const document = JSON.parse(createOwnedSource()) as {
    elements: Array<Record<string, unknown>>;
  };
  document.elements[0]!.futureData = true;
  return JSON.stringify(document);
}

describe("document loading boundaries", () => {
  beforeEach(() => {
    boundaryMocks.getOwnedScene.mockReset();
    boundaryMocks.getSharedScene.mockReset();
  });

  it("loads canonical database data and keeps the database name authoritative", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createOwnedSource()),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      documentVersion: 3,
      name: "Renamed in database",
      revision: 7,
      updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      workspaceId: "workspace-1",
    });

    const loaded = await importSceneDataBySceneId("scene-1");

    expect(loaded.document?.elements.map((element) => element.id)).toEqual([
      "owned-element",
    ]);
    expect(loaded.document?.state).toMatchObject({
      name: "Renamed in database",
      theme: "dark",
      viewBackgroundColor: "#111111",
      gridSize: 16,
    });
    expect(loaded.document?.assets["owned-asset"]?.dataURL).toBe(
      "data:image/png;base64,AA==",
    );
    expect(loaded.document?.assets["deleted-asset"]).toBeUndefined();
    expect(loaded).toMatchObject({
      revision: 7,
      updatedAt: "2026-01-02T03:04:05.000Z",
      workspaceId: "workspace-1",
    });
  });

  it("loads canonical shared data", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createOwnedSource()),
      {},
    );
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
      documentVersion: 3,
    });

    const loaded = await importDataFromBackend("shared-1", "unused-key");

    expect(loaded?.elements.map((element) => element.id)).toEqual([
      "owned-element",
    ]);
    expect(loaded?.state).toMatchObject({
      name: "Embedded name",
      theme: "dark",
    });
    expect(loaded?.assets["owned-asset"]?.id).toBe("owned-asset");
    expect(loaded?.assets["deleted-asset"]).toBeUndefined();
  });

  it("refuses non-canonical database data", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createNonCanonicalSource()),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      documentVersion: 3,
      name: "Invalid",
      revision: 1,
      updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      workspaceId: "workspace-1",
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(importSceneDataBySceneId("scene-1")).resolves.toEqual({});
    consoleError.mockRestore();
  });

  it("refuses non-canonical shared data", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createNonCanonicalSource()),
      {},
    );
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
      documentVersion: 3,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      importDataFromBackend("shared-1", "unused-key"),
    ).resolves.toBeNull();
    consoleError.mockRestore();
  });

  it("preserves the legacy-share expiration error from the API", async () => {
    boundaryMocks.getSharedScene.mockRejectedValue(
      new Error("LEGACY_SHARE_EXPIRED"),
    );

    await expect(
      importDataFromBackend("legacy-share", "unused-key"),
    ).rejects.toMatchObject({
      name: "LegacySharedSceneExpiredError",
      message: "LEGACY_SHARE_EXPIRED",
    });
  });
});
