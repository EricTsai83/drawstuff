import { describe, expect, it, vi } from "vitest";
import {
  createWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  type WhiteboardAssetV2,
  type WhiteboardElementV2,
} from "@/features/whiteboard";
import { compressData } from "@/lib/encode";
import { loadPublishedSceneData } from "@/lib/published-scene-data";

const INLINE_DATA_URL = "data:image/png;base64,AA==";

function imageElement(
  id: string,
  fileId: string,
  isDeleted = false,
): WhiteboardElementV2 {
  return {
    id,
    type: "image",
    isDeleted,
    fileId,
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: "#1b1b1f",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 1,
    locked: false,
  };
}

function inlineAsset(id: string, dataURL = INLINE_DATA_URL): WhiteboardAssetV2 {
  return {
    id,
    storage: "inline",
    dataURL,
    mimeType: "image/png",
    created: 1,
  };
}

function externalAsset(id: string): WhiteboardAssetV2 {
  return {
    id,
    storage: "external",
    mimeType: "image/png",
    created: 1,
  };
}

async function encodeDocument(options: {
  elements: readonly WhiteboardElementV2[];
  assets: Readonly<Record<string, WhiteboardAssetV2>>;
}): Promise<string> {
  const document = createWhiteboardDocumentV2({
    ...options,
    metadata: {
      name: "Published scene",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  });
  const compressed = await compressData(
    new TextEncoder().encode(serializeWhiteboardDocumentV2(document)),
    {},
  );
  return Buffer.from(compressed).toString("base64");
}

async function encodePublishedAsset(
  id: string,
  dataURL: string,
): Promise<Uint8Array> {
  return await compressData(new TextEncoder().encode(dataURL), {
    metadata: {
      id,
      mimeType: "image/png",
      created: 2,
    },
  });
}

describe("published scene data", () => {
  it("loads a canonical document with an inline asset in read-only mode", async () => {
    const id = "inline-file";
    const loaded = await loadPublishedSceneData({
      sceneData: await encodeDocument({
        elements: [imageElement("inline-image", id)],
        assets: { [id]: inlineAsset(id) },
      }),
      fileRecords: [],
    });

    expect(loaded.state.viewModeEnabled).toBe(true);
    expect(loaded.state.zenModeEnabled).toBe(true);
    expect(loaded.assets[id]?.dataURL).toBe(INLINE_DATA_URL);
  });

  it("hydrates a canonical external asset from its published file record", async () => {
    const id = "external-file";
    const compressed = await encodePublishedAsset(id, INLINE_DATA_URL);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from(compressed).buffer, { status: 200 }),
      ),
    );

    const loaded = await loadPublishedSceneData({
      sceneData: await encodeDocument({
        elements: [imageElement("external-image", id)],
        assets: { [id]: externalAsset(id) },
      }),
      fileRecords: [{ url: "https://files.example/external-image" }],
    });

    expect(loaded.assets[id]?.dataURL).toBe(INLINE_DATA_URL);
  });

  it("prefers a separately published asset over stale inline bytes", async () => {
    const id = "precedence-file";
    const publishedDataURL = "data:image/png;base64,AQ==";
    const compressed = await encodePublishedAsset(id, publishedDataURL);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from(compressed).buffer, { status: 200 }),
      ),
    );

    const loaded = await loadPublishedSceneData({
      sceneData: await encodeDocument({
        elements: [imageElement("precedence-image", id)],
        assets: { [id]: inlineAsset(id) },
      }),
      fileRecords: [{ url: "https://files.example/newer-image" }],
    });

    expect(loaded.assets[id]?.dataURL).toBe(publishedDataURL);
  });

  it("keeps an external image placeholder renderable when its file record is missing", async () => {
    const id = "missing-file";
    const loaded = await loadPublishedSceneData({
      sceneData: await encodeDocument({
        elements: [imageElement("missing-image", id)],
        assets: { [id]: externalAsset(id) },
      }),
      fileRecords: [],
    });

    expect(
      loaded.elements[0]?.type === "image"
        ? loaded.elements[0].fileId
        : undefined,
    ).toBe(id);
    expect(loaded.assets).toEqual({});
  });

  it("does not retain assets referenced only by deleted elements", async () => {
    const id = "deleted-file";
    const loaded = await loadPublishedSceneData({
      sceneData: await encodeDocument({
        elements: [imageElement("deleted-image", id, true)],
        assets: {},
      }),
      fileRecords: [],
    });

    expect(loaded.assets).toEqual({});
  });
});
