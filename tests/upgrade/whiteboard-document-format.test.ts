import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  importFromLocalStorage,
  saveWhiteboardDocumentToLocalStorage,
} from "@/data/local-storage";
import {
  createWhiteboardDocumentV1,
  detectWhiteboardDocumentFormat,
  migrateLegacyExcalidrawScene,
  parsePersistedWhiteboardPayload,
  parseWhiteboardDocumentV1,
  serializeWhiteboardDocumentV1,
  WhiteboardDocumentError,
  type WhiteboardAsset,
  type WhiteboardDocumentV1,
  type WhiteboardElement,
} from "@/features/whiteboard";
import { decompressData } from "@/lib/encode";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";

const fixtureDirectory = path.join(
  process.cwd(),
  "tests/fixtures/legacy-scenes",
);

const legacyFixtureNames = [
  "images-and-binary-files.excalidraw",
  "large-groups-and-viewport.excalidraw",
  "pre-migration-bindings.excalidraw",
  "shapes-and-text.excalidraw",
  "supported-elements-and-assets.excalidraw",
] as const;

const expectedMigrationHashes: Record<
  (typeof legacyFixtureNames)[number],
  string
> = {
  "images-and-binary-files.excalidraw":
    "f02f20fdbbff17bf521799edc7c7aef650713bc36dde8748f08adac0762c02e0",
  "large-groups-and-viewport.excalidraw":
    "640f3096df1da32df6a110a1c6dc1cd449d21c36774a6efd64603d5692d843c3",
  "pre-migration-bindings.excalidraw":
    "f71561bbce9f4c08a6dc44b6437503fd452f8a7f324b9813193d00e3604a38a6",
  "shapes-and-text.excalidraw":
    "dd029dcabf6497eca3abdcbe56b459aef77968c12ab510f6db6eb9ca3b1f69ed",
  "supported-elements-and-assets.excalidraw":
    "9b52bb8793d2b936763fdebb47cd0b90553f3305e10d6521e21ad1b1e180be9a",
};

async function readFixtureSource(name: string): Promise<string> {
  return await readFile(path.join(fixtureDirectory, name), "utf8");
}

function createElement(
  overrides?: Partial<WhiteboardElement>,
): WhiteboardElement {
  return {
    id: "element-1",
    type: "rectangle",
    isDeleted: false,
    ...overrides,
  };
}

function createAsset(id = "asset-1"): WhiteboardAsset {
  return {
    id,
    dataURL: "data:image/png;base64,AA==",
    mimeType: "image/png",
    created: 123,
    lastRetrieved: 456,
  };
}

function createOwnedDocument(
  overrides?: Partial<WhiteboardDocumentV1>,
): WhiteboardDocumentV1 {
  return createWhiteboardDocumentV1({
    elements: overrides?.elements ?? [createElement()],
    assets: overrides?.assets ?? {},
    metadata: overrides?.metadata ?? {
      name: "Owned",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  });
}

describe("whiteboard document format", () => {
  it.each(legacyFixtureNames)(
    "migrates %s to stable, byte-identical output",
    async (fixtureName) => {
      const source = await readFixtureSource(fixtureName);
      const first = serializeWhiteboardDocumentV1(
        migrateLegacyExcalidrawScene(source),
      );
      const second = serializeWhiteboardDocumentV1(
        migrateLegacyExcalidrawScene(source),
      );
      const hash = createHash("sha256").update(first).digest("hex");

      expect(second).toBe(first);
      expect(hash).toBe(expectedMigrationHashes[fixtureName]);
      expect(parseWhiteboardDocumentV1(first)).toEqual(
        migrateLegacyExcalidrawScene(source),
      );
    },
  );

  it("promotes the saved viewport while retaining unknown legacy data in rollback", async () => {
    const source = await readFixtureSource(
      "large-groups-and-viewport.excalidraw",
    );
    const document = migrateLegacyExcalidrawScene(source);

    expect(document.metadata).toMatchObject({
      name: "Legacy grouped scene with viewport",
      theme: "dark",
      viewBackgroundColor: "#f8f9fa",
      viewport: {
        scrollX: 315.5,
        scrollY: 188.25,
        zoom: 0.75,
      },
      legacy: {
        format: "excalidraw",
        sourceVersion: 2,
        migrationVersion: 1,
        originalPayload: source,
      },
    });
    expect(document.metadata.legacy?.unsupported).not.toHaveProperty(
      "$.appState.scrollX",
    );
  });

  it("covers every declared supported legacy element and asset MIME type", async () => {
    const source = await readFixtureSource(
      "supported-elements-and-assets.excalidraw",
    );
    const document = migrateLegacyExcalidrawScene(source);

    expect(new Set(document.elements.map((element) => element.type))).toEqual(
      new Set([
        "arrow",
        "diamond",
        "ellipse",
        "embeddable",
        "frame",
        "freedraw",
        "iframe",
        "image",
        "line",
        "magicframe",
        "rectangle",
        "text",
      ]),
    );
    expect(
      new Set(Object.values(document.assets).map((asset) => asset.mimeType)),
    ).toEqual(
      new Set([
        "application/octet-stream",
        "image/avif",
        "image/bmp",
        "image/gif",
        "image/jpeg",
        "image/jfif",
        "image/png",
        "image/svg+xml",
        "image/vnd.microsoft.icon",
        "image/webp",
        "image/x-icon",
      ]),
    );
    expect(document.metadata.legacy?.unsupported).toEqual({});
  });

  it("records unknown top-level, state, element, asset, and element-type data", () => {
    const asset = { ...createAsset(), futureAssetField: { codec: "v2" } };
    const input = {
      type: "excalidraw",
      version: 2,
      source: "fixture",
      futureTopLevel: true,
      elements: [
        {
          ...createElement({ type: "future-shape" }),
          futureElementField: [1, 2, 3],
        },
      ],
      appState: {
        name: "Future",
        theme: "dark",
        viewBackgroundColor: "#000000",
        futureStateField: "retained",
      },
      files: { [asset.id]: asset },
    };
    const before = JSON.stringify(input);
    const document = migrateLegacyExcalidrawScene(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(document.metadata.legacy?.unsupported).toMatchObject({
      "$.futureTopLevel": true,
      "$.appState.futureStateField": "retained",
      "$.elements[0].futureElementField": [1, 2, 3],
      "$.files.asset-1.futureAssetField": { codec: "v2" },
    });
    expect(
      document.metadata.legacy?.unsupported["$.elements[0]"],
    ).toMatchObject({ type: "future-shape" });
  });

  it("rejects non-inline and non-image owned assets", () => {
    const baseDocument = {
      version: 1,
      elements: [
        createElement({
          id: "image-1",
          type: "image",
          fileId: "asset-1",
        }),
      ],
      metadata: {
        name: "Unsafe",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    } as const;

    expect(() =>
      parseWhiteboardDocumentV1({
        ...baseDocument,
        assets: {
          "asset-1": {
            ...createAsset(),
            dataURL: "https://attacker.example/beacon.png",
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MALFORMED_DOCUMENT",
        path: "$.assets.asset-1.dataURL",
      }),
    );
    expect(() =>
      parseWhiteboardDocumentV1({
        ...baseDocument,
        assets: {
          "asset-1": {
            ...createAsset(),
            dataURL: "data:text/html;base64,AA==",
            mimeType: "text/html",
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MALFORMED_DOCUMENT",
        path: "$.assets.asset-1.mimeType",
      }),
    );
  });

  it("rejects a missing live image asset but permits a deleted image rollback record", () => {
    const liveImage = {
      type: "excalidraw",
      version: 2,
      elements: [
        createElement({
          id: "image-1",
          type: "image",
          fileId: "missing",
        }),
      ],
      appState: {},
      files: {},
    };

    expect(() => migrateLegacyExcalidrawScene(liveImage)).toThrowError(
      expect.objectContaining({
        code: "MISSING_ASSET",
        path: "$.elements[0].fileId",
      }),
    );

    const deleted = {
      ...liveImage,
      elements: [{ ...liveImage.elements[0]!, isDeleted: true }],
    };
    expect(migrateLegacyExcalidrawScene(deleted).elements[0]).toMatchObject({
      id: "image-1",
      isDeleted: true,
      fileId: "missing",
    });

    expect(() =>
      parseWhiteboardDocumentV1({
        version: 1,
        elements: liveImage.elements,
        assets: {},
        metadata: {
          name: "Unsafe owned document",
          theme: "light",
          viewBackgroundColor: "#ffffff",
          gridSize: null,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MISSING_ASSET",
        path: "$.elements[0].fileId",
      }),
    );
  });

  it.each([
    {
      payload: "{",
      code: "INVALID_JSON",
      path: "$",
    },
    {
      payload: {
        type: "excalidraw",
        version: 2,
        elements: [{ id: "bad", isDeleted: false }],
        appState: {},
      },
      code: "MALFORMED_DOCUMENT",
      path: "$.elements[0].type",
    },
    {
      payload: {
        type: "excalidraw",
        version: 2,
        elements: [createElement(), createElement({ type: "ellipse" })],
        appState: {},
      },
      code: "MALFORMED_DOCUMENT",
      path: "$.elements[1].id",
    },
  ])("rejects malformed input with $code and no partial result", (testCase) => {
    let error: unknown;
    try {
      migrateLegacyExcalidrawScene(testCase.payload);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WhiteboardDocumentError);
    expect(error).toMatchObject({
      code: testCase.code,
      path: testCase.path,
    });
  });

  it("rejects newer owned and Excalidraw versions explicitly", () => {
    expect(() =>
      detectWhiteboardDocumentFormat({
        version: 2,
        elements: [],
        assets: {},
        metadata: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_VERSION",
        path: "$.version",
      }),
    );
    expect(() =>
      detectWhiteboardDocumentFormat({
        type: "excalidraw",
        version: 3,
        elements: [],
        appState: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_VERSION",
        path: "$.version",
      }),
    );
  });

  it("normalizes supported older legacy defaults without an Excalidraw runtime", () => {
    const document = migrateLegacyExcalidrawScene({
      type: "excalidraw",
      version: 1,
      elements: [{ id: "old-element", type: "rectangle" }],
      files: {
        "old-asset": {
          id: "old-asset",
          dataURL: "data:image/png;base64,AA==",
          mimeType: "image/png",
        },
      },
    });

    expect(document.elements).toEqual([
      { id: "old-element", type: "rectangle", isDeleted: false },
    ]);
    expect(document.assets).toEqual({});
    expect(document.metadata).toMatchObject({
      name: "",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
      legacy: {
        sourceVersion: 1,
        migrationVersion: 1,
      },
    });
  });

  it("prunes assets referenced only by deleted elements from migrated output", () => {
    const asset = createAsset();
    const document = migrateLegacyExcalidrawScene({
      type: "excalidraw",
      version: 2,
      elements: [
        createElement({
          id: "deleted-image",
          type: "image",
          fileId: asset.id,
          isDeleted: true,
        }),
      ],
      appState: {},
      files: { [asset.id]: asset },
    });

    expect(document.assets).toEqual({});
    expect(document.metadata.legacy?.originalPayload).toContain(asset.dataURL);
  });

  it("detects and round-trips an owned document without session state", () => {
    const document = createOwnedDocument();
    const serialized = serializeWhiteboardDocumentV1(document);
    const persisted = parsePersistedWhiteboardPayload(serialized);

    expect(detectWhiteboardDocumentFormat(serialized)).toBe("whiteboard-v1");
    expect(persisted).toEqual({
      format: "whiteboard-v1",
      document,
    });
    expect(serialized).not.toContain("selectedElementIds");
    expect(serialized).not.toContain("openDialog");
    expect(serialized).not.toContain("activeTool");
    expect(serialized).not.toContain("scrollX");
  });
});

describe("owned-format persistence opt-in", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips local owned data without replacing the retained legacy keys", () => {
    const document = createOwnedDocument();
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "[]");
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify({ name: "Rollback copy" }),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "{}");

    expect(saveWhiteboardDocumentToLocalStorage(document)).toBe(true);
    const loaded = importFromLocalStorage();

    expect(loaded.elements).toEqual(document.elements);
    expect(loaded.appState).toMatchObject({ name: "Owned", theme: "light" });
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      "[]",
    );
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE),
    ).toContain("Rollback copy");
  });

  it("reports local quota failures without throwing", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });

    expect(saveWhiteboardDocumentToLocalStorage(createOwnedDocument())).toBe(
      false,
    );

    setItem.mockRestore();
    consoleError.mockRestore();
  });

  it("falls back to the untouched legacy snapshot when the owned copy is malformed", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      '{"version":1}',
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([createElement({ id: "legacy" })]),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify({ name: "Legacy fallback" }),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "{}");

    const loaded = importFromLocalStorage();

    expect(loaded.elements[0]?.id).toBe("legacy");
    expect(loaded.appState?.name).toBe("Legacy fallback");
  });

  it("round-trips the opt-in server serialization through compression", async () => {
    const asset = createAsset();
    const element = createElement({
      id: "image-1",
      type: "image",
      fileId: asset.id,
    });
    const prepared = await prepareSceneDataForExport(
      [element],
      {
        name: "Server owned",
        theme: "dark",
        viewBackgroundColor: "#101010",
        gridSize: 20,
        scrollX: 999,
        scrollY: 333,
        zoom: { value: 0.8 },
        openDialog: { name: "export" },
      },
      { [asset.id]: asset },
      { encrypt: false },
    );
    const decompressed = await decompressData<Record<string, never>>(
      prepared.compressedSceneData,
      { decryptionKey: "" },
    );
    const source = new TextDecoder().decode(decompressed.data);
    const document = parseWhiteboardDocumentV1(source);

    expect(document).toMatchObject({
      version: 1,
      elements: [{ id: "image-1", fileId: "asset-1" }],
      assets: { "asset-1": asset },
      metadata: {
        name: "Server owned",
        theme: "dark",
        viewBackgroundColor: "#101010",
        gridSize: 20,
        viewport: {
          scrollX: 999,
          scrollY: 333,
          zoom: 0.8,
        },
      },
    });
    expect(source).toContain('"scrollX":999');
    expect(source).not.toContain("openDialog");
  });

  it("stores cloud assets separately and compacts rollback asset bytes", async () => {
    const asset = createAsset();
    const element = createElement({
      id: "image-1",
      type: "image",
      fileId: asset.id,
    });
    const prepared = await prepareSceneDataForExport(
      [element],
      { name: "Compact cloud", theme: "light" },
      { [asset.id]: asset },
      {
        encrypt: false,
        includeInlineAssets: false,
        retainLegacy: true,
        compactLegacyAssets: true,
        persistence: {
          sourceFormat: "whiteboard-v1",
          documentVersion: 1,
          legacyRollback: {
            format: "excalidraw",
            sourceVersion: 2,
            migrationVersion: 1,
            originalPayload: JSON.stringify({
              type: "excalidraw",
              version: 2,
              elements: [element],
              appState: {},
              files: { [asset.id]: asset },
            }),
            unsupported: {},
          },
        },
      },
    );
    const decompressed = await decompressData<Record<string, never>>(
      prepared.compressedSceneData,
      { decryptionKey: "" },
    );
    const source = new TextDecoder().decode(decompressed.data);
    const document = parseWhiteboardDocumentV1(source, {
      allowMissingAssets: true,
    });

    expect(document.assets).toEqual({});
    expect(document.metadata.legacy?.originalPayload).toContain('"files":{}');
    expect(source).not.toContain(asset.dataURL);
  });
});
