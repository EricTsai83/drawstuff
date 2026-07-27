import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistedWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
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
  return serializeWhiteboardDocumentV2(
    createPersistedWhiteboardDocumentV2({
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
      state: {
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
    vi.stubEnv("NEXT_PUBLIC_WHITEBOARD_V2_READ_CUTOVER", "true");
    boundaryMocks.getOwnedScene.mockReset();
    boundaryMocks.getSharedScene.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects owned database data and keeps the database name authoritative", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createOwnedSource()),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      documentVersion: 2,
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

  it("detects owned shared data without a legacy runtime boundary", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createOwnedSource()),
      {},
    );
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
      documentVersion: 2,
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

  it("refuses an unversioned legacy database shape after cutover", async () => {
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

    expect(loaded).toEqual({});
  });

  it("refuses an unversioned legacy shared shape after cutover", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(createLegacyServerSource()),
      {},
    );
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
    });

    const loaded = await importDataFromBackend("legacy-shared", "unused-key");

    expect(loaded).toBeNull();
  });

  it("keeps legacy owned and shared rows readable before cutover", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHITEBOARD_V2_READ_CUTOVER", "false");
    const compressed = await compressData(
      new TextEncoder().encode(createLegacyServerSource()),
      {},
    );
    boundaryMocks.getOwnedScene.mockResolvedValue({
      sceneData: Buffer.from(compressed).toString("base64"),
      name: "Database legacy name",
      revision: 3,
    });
    boundaryMocks.getSharedScene.mockResolvedValue({
      compressedData: compressed,
    });

    const [owned, shared] = await Promise.all([
      importSceneDataBySceneId("legacy-scene"),
      importDataFromBackend("legacy-shared", "unused-key"),
    ]);

    expect(owned.document?.elements[0]?.id).toBe("legacy-element");
    expect(shared?.elements[0]?.id).toBe("legacy-element");
  });

  it("refuses missing and duplicate legacy ids without a partial result", async () => {
    const compressed = await compressData(
      new TextEncoder().encode(
        JSON.stringify({
          elements: [
            { type: "rectangle" },
            { id: "duplicate", type: "ellipse" },
            { id: "duplicate", type: "diamond" },
            { id: "legacy-0", type: "line" },
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

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loaded = await importSceneDataBySceneId("repairable");

    expect(loaded.document).toBeUndefined();
  });
});
