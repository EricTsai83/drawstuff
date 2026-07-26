import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  WhiteboardAsset,
  WhiteboardDocumentState,
  WhiteboardElement,
} from "@/features/whiteboard";
import { STORAGE_KEYS } from "@/config/app-constants";
import { importFromLocalStorage } from "@/data/local-storage";
import { decode, decompressData, encode } from "@/lib/encode";
import { hasCompleteSceneAssetHydration } from "@/lib/whiteboard";
import { extractImageFiles, processFilesForUpload } from "@/lib/file-processor";
import { loadPublishedSceneData } from "@/lib/published-scene-data";
import {
  createWhiteboardDocumentV1,
  migrateLegacyExcalidrawScene,
  serializeWhiteboardDocumentV1,
} from "@/features/whiteboard";

type SceneFixture = {
  type: "excalidraw";
  version: 2;
  elements: WhiteboardElement[];
  appState: WhiteboardDocumentState;
  files: Record<string, WhiteboardAsset>;
};

const fixtureDirectory = path.join(
  process.cwd(),
  "tests/fixtures/legacy-scenes",
);

async function readFixture(name: string): Promise<SceneFixture> {
  const source = await readFile(path.join(fixtureDirectory, name), "utf8");
  return JSON.parse(source) as SceneFixture;
}

describe("legacy Excalidraw scenes", () => {
  it("decodes UTF-8 scene text persisted by Pako 2", async () => {
    const source = (
      await readFile(
        path.join(fixtureDirectory, "utf8-text.pako-2-encoded.base64"),
        "utf8",
      )
    ).trim();
    const encoded = Buffer.from(source, "base64").toString("latin1");

    expect(
      decode({
        encoded,
        encoding: "bstring",
        compressed: true,
        version: "1",
      }),
    ).toBe(
      JSON.stringify({
        name: "舊場景",
        elements: [{ id: "shape-1", type: "rectangle" }],
      }),
    );
  });

  it("round-trips UTF-8 scene text through the browser compression path", () => {
    const sceneText = JSON.stringify({
      name: "舊場景",
      elements: [{ id: "shape-1", type: "rectangle" }],
    });
    const encoded = encode({ text: sceneText });

    expect(encoded.compressed).toBe(true);
    expect(decode(encoded)).toBe(sceneText);
  });

  it.each([
    ["shapes-and-text.excalidraw", 2],
    ["images-and-binary-files.excalidraw", 1],
    ["large-groups-and-viewport.excalidraw", 5],
    ["pre-migration-bindings.excalidraw", 2],
  ])("migrates %s without dropping content", async (name, elementCount) => {
    const fixture = await readFixture(name);
    const migrated = migrateLegacyExcalidrawScene(fixture);

    expect(migrated.elements).toHaveLength(elementCount);
    expect(migrated.elements.every((element) => !element.isDeleted)).toBe(true);
  });

  it("preserves arrows, groups, and saved viewport state", async () => {
    const fixture = await readFixture("large-groups-and-viewport.excalidraw");
    const migrated = migrateLegacyExcalidrawScene(fixture);
    const groupIds = new Set(
      migrated.elements.flatMap((element) =>
        "groupIds" in element && Array.isArray(element.groupIds)
          ? (element.groupIds as string[])
          : [],
      ),
    );

    expect(migrated.elements.some((element) => element.type === "arrow")).toBe(
      true,
    );
    expect(groupIds).toContain("legacy-group-a");
    expect(migrated.metadata.viewport).toEqual({
      scrollX: 315.5,
      scrollY: 188.25,
      zoom: 0.75,
    });
  });

  it("preserves pre-index binding data for the runtime-free importer", async () => {
    const fixture = await readFixture("pre-migration-bindings.excalidraw");
    const migrated = migrateLegacyExcalidrawScene(fixture);
    const box = migrated.elements.find(
      (element) => element.id === "legacy-old-box",
    );

    expect(box).toMatchObject({
      id: "legacy-old-box",
      type: "rectangle",
      x: 40,
      y: 40,
      width: 180,
      height: 100,
    });
    expect(migrated.metadata.legacy?.unsupported).toBeDefined();
  });

  it("loads a stable compressed legacy payload", async () => {
    const source = (
      await readFile(
        path.join(fixtureDirectory, "shapes-and-text.pako-2-compressed.base64"),
        "utf8",
      )
    ).trim();
    const compressed = Uint8Array.from(Buffer.from(source, "base64"));
    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
    });
    const parsed = JSON.parse(new TextDecoder().decode(data)) as SceneFixture;

    expect(parsed.type).toBe("excalidraw");
    expect(parsed.elements.map((element) => element.type)).toEqual([
      "rectangle",
      "text",
    ]);
  });
});

describe("local recovery and binary files", () => {
  it("recovers local elements, viewport, and files while removing deleted elements", async () => {
    const fixture = await readFixture("images-and-binary-files.excalidraw");
    const deletedElement = {
      ...fixture.elements[0]!,
      id: "deleted-image",
      isDeleted: true,
    };

    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([...fixture.elements, deletedElement]),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify({ ...fixture.appState, scrollX: 42, scrollY: -8 }),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_FILES,
      JSON.stringify(fixture.files),
    );

    const recovered = importFromLocalStorage();

    expect(recovered.elements.map((element) => element.id)).toEqual([
      "legacy-image",
    ]);
    expect(recovered.appState).toMatchObject({ scrollX: 42, scrollY: -8 });
    expect(recovered.files["legacy-image-file"]?.mimeType).toBe("image/png");
  });

  it("compresses an uploaded image and restores its binary metadata and data URL", async () => {
    const fixture = await readFixture("images-and-binary-files.excalidraw");
    const imageFiles = extractImageFiles(fixture.elements, fixture.files);
    const [processed] = await processFilesForUpload({
      files: imageFiles,
      maxBytes: 1024 * 1024,
      encryptionKey: null,
    });

    expect(processed?.id).toBe("legacy-image-file");
    const restored = await decompressData<{
      id: string;
      mimeType: string;
      created: number;
      lastRetrieved: number;
    }>(processed!.buffer, { decryptionKey: "" });
    const dataURL = new TextDecoder().decode(restored.data);

    expect(restored.metadata.id).toBe("legacy-image-file");
    expect(restored.metadata.mimeType).toBe("image/png");
    expect(dataURL).toBe(fixture.files["legacy-image-file"]?.dataURL);
    expect(
      hasCompleteSceneAssetHydration(fixture.elements, fixture.files),
    ).toBe(true);
    expect(hasCompleteSceneAssetHydration(fixture.elements, {})).toBe(false);
  });

  it("loads published scene data in read-only mode with restored binary files", async () => {
    const fixture = await readFixture("images-and-binary-files.excalidraw");
    const sceneBytes = new TextEncoder().encode(JSON.stringify(fixture));
    const { compressData } = await import("@/lib/encode");
    const compressedScene = await compressData(sceneBytes, {});
    const binary = fixture.files["legacy-image-file"]!;
    const compressedFile = await compressData(
      new TextEncoder().encode(binary.dataURL),
      {
        metadata: {
          id: binary.id,
          mimeType: binary.mimeType,
          created: binary.created,
          lastRetrieved: binary.lastRetrieved,
        },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from(compressedFile).buffer, { status: 200 }),
      ),
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [{ url: "https://files.example/legacy-image" }],
    });

    expect(loaded.state.viewModeEnabled).toBe(true);
    expect(loaded.state.zenModeEnabled).toBe(true);
    expect(loaded.state.scrollX).toBeUndefined();
    expect(loaded.assets["legacy-image-file"]?.dataURL).toBe(binary.dataURL);
  });

  it("loads the unversioned legacy server shape at the published boundary", async () => {
    const { compressData } = await import("@/lib/encode");
    const compressedScene = await compressData(
      new TextEncoder().encode(
        JSON.stringify({
          elements: [{ id: "server-legacy", type: "rectangle" }],
          appState: {
            name: "Unversioned server scene",
            theme: "light",
            viewBackgroundColor: "#ffffff",
          },
        }),
      ),
      {},
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [],
    });

    expect(loaded.elements?.map((element) => element.id)).toEqual([
      "server-legacy",
    ]);
    expect(loaded.state.name).toBe("Unversioned server scene");
    expect(loaded.state.viewModeEnabled).toBe(true);
  });

  it("detects and loads an owned published document with inline assets", async () => {
    const source = await readFile(
      path.join(fixtureDirectory, "images-and-binary-files.excalidraw"),
      "utf8",
    );
    const document = migrateLegacyExcalidrawScene(source);
    const { compressData } = await import("@/lib/encode");
    const compressedScene = await compressData(
      new TextEncoder().encode(serializeWhiteboardDocumentV1(document)),
      {},
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [],
    });

    expect(loaded.elements?.map((element) => element.id)).toEqual([
      "legacy-image",
    ]);
    expect(loaded.state.name).toBe("Legacy image and binary file");
    expect(loaded.state.viewModeEnabled).toBe(true);
    expect(loaded.assets["legacy-image-file"]?.dataURL).toBe(
      document.assets["legacy-image-file"]?.dataURL,
    );
  });

  it("hydrates an owned published document whose asset record is stored separately", async () => {
    const { compressData } = await import("@/lib/encode");
    const source = {
      version: 1,
      elements: [
        {
          id: "owned-published-image",
          type: "image",
          isDeleted: false,
          fileId: "owned-published-file",
        },
      ],
      assets: {},
      metadata: {
        name: "External owned image",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    };
    const compressedScene = await compressData(
      new TextEncoder().encode(JSON.stringify(source)),
      {},
    );
    const dataURL = "data:image/png;base64,AA==";
    const compressedFile = await compressData(
      new TextEncoder().encode(dataURL),
      {
        metadata: {
          id: "owned-published-file",
          mimeType: "image/png",
          created: 1,
        },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from(compressedFile).buffer, { status: 200 }),
      ),
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [{ url: "https://files.example/owned-image" }],
    });

    expect(loaded.assets["owned-published-file"]?.dataURL).toBe(dataURL);
  });

  it("prefers the separately published asset record over a stale inline copy", async () => {
    const { compressData } = await import("@/lib/encode");
    const id = "published-precedence-file";
    const compressedScene = await compressData(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          elements: [
            {
              id: "published-precedence-image",
              type: "image",
              isDeleted: false,
              fileId: id,
            },
          ],
          assets: {
            [id]: {
              id,
              dataURL: "data:image/png;base64,AA==",
              mimeType: "image/png",
              created: 1,
            },
          },
          metadata: {
            name: "Published precedence",
            theme: "light",
            viewBackgroundColor: "#ffffff",
            gridSize: null,
          },
        }),
      ),
      {},
    );
    const publishedDataURL = "data:image/png;base64,AQ==";
    const compressedFile = await compressData(
      new TextEncoder().encode(publishedDataURL),
      {
        metadata: { id, mimeType: "image/png", created: 2 },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from(compressedFile).buffer, { status: 200 }),
      ),
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [{ url: "https://files.example/newer-owned-image" }],
    });

    expect(loaded.assets[id]?.dataURL).toBe(publishedDataURL);
  });

  it("keeps an owned published document renderable when an asset record is missing", async () => {
    const { compressData } = await import("@/lib/encode");
    const compressedScene = await compressData(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          elements: [
            {
              id: "missing-owned-image",
              type: "image",
              isDeleted: false,
              fileId: "missing-owned-file",
            },
          ],
          assets: {},
          metadata: {
            name: "Missing owned image",
            theme: "light",
            viewBackgroundColor: "#ffffff",
            gridSize: null,
          },
        }),
      ),
      {},
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [],
    });

    expect(loaded.elements?.[0]?.fileId).toBe("missing-owned-file");
    expect(loaded.assets).toEqual({});
  });

  it("does not hydrate inline assets referenced only by deleted elements", async () => {
    const document = createWhiteboardDocumentV1({
      elements: [
        {
          id: "deleted-image",
          type: "image",
          isDeleted: true,
          fileId: "private-asset",
        },
      ],
      assets: {
        "private-asset": {
          id: "private-asset",
          dataURL: "data:image/png;base64,AA==",
          mimeType: "image/png",
          created: 1,
        },
      },
      metadata: {
        name: "Deleted asset",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });
    const { compressData } = await import("@/lib/encode");
    const compressedScene = await compressData(
      new TextEncoder().encode(serializeWhiteboardDocumentV1(document)),
      {},
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [],
    });

    expect(loaded.assets).toEqual({});
  });
});
