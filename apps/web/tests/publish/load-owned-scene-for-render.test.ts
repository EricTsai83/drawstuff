import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getScene: vi.fn(),
  getFileRecordsBySceneId: vi.fn(),
  decompressData: vi.fn(),
  decodePersistedScene: vi.fn(),
}));

vi.mock("@/trpc/client", () => ({
  getTrpcClient: () => ({
    scene: {
      getScene: { query: mocks.getScene },
      getFileRecordsBySceneId: { query: mocks.getFileRecordsBySceneId },
    },
  }),
}));
vi.mock("@/lib/encode", () => ({
  base64ToArrayBuffer: () => new ArrayBuffer(1),
  decompressData: mocks.decompressData,
}));
vi.mock("@/lib/persisted-scene", () => ({
  decodePersistedScene: mocks.decodePersistedScene,
}));

import { loadOwnedSceneForRender } from "@/lib/import-data-from-db";

const image = (fileId: string) => ({
  id: `el-${fileId}`,
  type: "image",
  fileId,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.getScene.mockResolvedValue({
    sceneData: "AQ==",
    revision: 7,
    name: "Scene",
  });
  mocks.decompressData.mockResolvedValue({
    data: new Uint8Array(),
    metadata: {},
  });
  mocks.decodePersistedScene.mockReturnValue({
    elements: [image("f1"), { ...image("f2"), isDeleted: true }],
    appState: {},
  });
});

describe("loadOwnedSceneForRender", () => {
  it("returns the document, its assets and the revision when every live image loaded", async () => {
    // One record, whose download decodes to the id the element references.
    mocks.getFileRecordsBySceneId.mockResolvedValue({
      files: [
        { url: "https://app.ufs.sh/f/k", excalidrawFileId: "f1", size: 1 },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([1])))),
    );
    mocks.decompressData
      .mockResolvedValueOnce({ data: new Uint8Array(), metadata: {} })
      .mockResolvedValueOnce({
        data: new TextEncoder().encode("data:image/png;base64,AA"),
        metadata: {
          id: "f1",
          mimeType: "image/png",
          created: 1,
          lastRetrieved: 1,
        },
      });

    const snapshot = await loadOwnedSceneForRender("scene-1");

    expect(snapshot.revision).toBe(7);
    expect(Object.keys(snapshot.files)).toEqual(["f1"]);
    expect(snapshot.elements).toHaveLength(2);
  });

  it("refuses to render when a referenced live image did not load", async () => {
    // The record request fails; the loader swallows it into an empty map.
    mocks.getFileRecordsBySceneId.mockRejectedValue(new Error("network"));

    await expect(loadOwnedSceneForRender("scene-1")).rejects.toThrow(
      /assets could not be loaded.*f1/,
    );
  });

  it("refuses an unreadable document", async () => {
    mocks.getScene.mockResolvedValue({ sceneData: null, revision: 7 });
    mocks.getFileRecordsBySceneId.mockResolvedValue({ files: [] });
    await expect(loadOwnedSceneForRender("scene-1")).rejects.toThrow(
      /could not be loaded/,
    );
  });
});
