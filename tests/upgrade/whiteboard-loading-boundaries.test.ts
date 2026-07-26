import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWhiteboardDocumentV1,
  serializeWhiteboardDocumentV1,
} from "@/features/whiteboard";
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
  return serializeWhiteboardDocumentV1(
    createWhiteboardDocumentV1({
      elements: [
        {
          id: "owned-element",
          type: "image",
          isDeleted: false,
          fileId: "owned-asset",
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
      metadata: {
        name: "Embedded name",
        theme: "dark",
        viewBackgroundColor: "#111111",
        gridSize: 16,
      },
    }),
  );
}

function createLegacyServerSource(): string {
  return JSON.stringify({
    elements: [{ id: "legacy-element", type: "ellipse" }],
    appState: {
      name: "Legacy server payload",
      theme: "light",
      viewBackgroundColor: "#fafafa",
    },
  });
}

describe("document loading boundaries", () => {
  beforeEach(() => {
    boundaryMocks.getOwnedScene.mockReset();
    boundaryMocks.getSharedScene.mockReset();
  });

  it("detects owned database data and keeps the database name authoritative", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createOwnedSource()),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      name: "Renamed in database",
      revision: 7,
      updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      workspaceId: "workspace-1",
    });

    const loaded = await importSceneDataBySceneId("scene-1");

    expect(loaded.elements?.map((element) => element.id)).toEqual([
      "owned-element",
    ]);
    expect(loaded.appState).toMatchObject({
      name: "Renamed in database",
      theme: "dark",
      viewBackgroundColor: "#111111",
      gridSize: 16,
    });
    expect(loaded.files?.["owned-asset"]?.dataURL).toBe(
      "data:image/png;base64,AA==",
    );
    expect(loaded.files?.["deleted-asset"]).toBeUndefined();
    expect(loaded).toMatchObject({
      revision: 7,
      updatedAt: "2026-01-02T03:04:05.000Z",
      workspaceId: "workspace-1",
    });
  });

  it("detects owned shared data before the Excalidraw restore boundary", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createOwnedSource()),
      {},
    );
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
    });

    const loaded = await importDataFromBackend("shared-1", "unused-key");

    expect(loaded.elements?.map((element) => element.id)).toEqual([
      "owned-element",
    ]);
    expect(loaded.appState).toMatchObject({
      name: "Embedded name",
      theme: "dark",
    });
    expect(loaded.files?.["owned-asset"]?.id).toBe("owned-asset");
    expect(loaded.files?.["deleted-asset"]).toBeUndefined();
  });

  it("keeps reading the exact unversioned legacy database shape", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createLegacyServerSource()),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      name: "Database legacy name",
      revision: 3,
    });

    const loaded = await importSceneDataBySceneId("legacy-scene");

    expect(loaded.elements).toEqual([
      {
        id: "legacy-element",
        type: "ellipse",
      },
    ]);
    expect(loaded.appState).toMatchObject({
      name: "Database legacy name",
      theme: "light",
      viewBackgroundColor: "#fafafa",
    });
    expect(loaded.revision).toBe(3);
  });

  it("keeps reading the exact unversioned legacy shared shape", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createLegacyServerSource()),
      {},
    );
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
    });

    const loaded = await importDataFromBackend("legacy-shared", "unused-key");

    expect(loaded.elements).toEqual([
      {
        id: "legacy-element",
        type: "ellipse",
      },
    ]);
    expect(loaded.appState?.name).toBe("Legacy server payload");
  });

  it("lets the runtime restore repair missing and duplicate legacy ids", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(
        JSON.stringify({
          elements: [
            { type: "rectangle" },
            { id: "duplicate", type: "ellipse" },
            { id: "duplicate", type: "diamond" },
            null,
          ],
          appState: { name: "Repairable legacy" },
        }),
      ),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      name: "Repairable legacy",
      revision: 1,
    });

    const loaded = await importSceneDataBySceneId("repairable");

    expect(loaded.elements).toHaveLength(3);
    expect(loaded.elements?.[0]?.id).toBeUndefined();
    expect(loaded.elements?.[1]?.id).toBe("duplicate");
    expect(loaded.elements?.[2]?.id).toBe("duplicate");
  });
});
