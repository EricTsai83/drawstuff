import { describe, expect, it, vi } from "vitest";
import {
  beginOwnedDrawing,
  createOwnedDrawingElement,
  createPersistedWhiteboardDocumentV3,
  isRasterSizeAllowed,
  materializeDrawingPoints,
  OWNED_FREEDRAW_CHUNK_SIZE,
  OWNED_RASTER_MAX_AREA,
  OwnedRasterCache,
  OwnedSpatialIndex,
  OwnedWhiteboardStore,
  parseWhiteboardDocumentV3,
  serializeWhiteboardDocumentV3,
  updateOwnedDrawing,
  type OwnedWhiteboardDocument,
  type WhiteboardElementStyle,
} from "@drawstuff/whiteboard";
import {
  createWhiteboardDocumentV2,
  migrateWhiteboardDocumentV2,
} from "@drawstuff/whiteboard/migration-v2";

const STYLE: WhiteboardElementStyle = {
  strokeColor: "#111111",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  opacity: 100,
  roughness: 1,
};

describe("V3 architecture", () => {
  it("serializes deterministically and rejects unknown fields", () => {
    const persisted = createPersistedWhiteboardDocumentV3(fixtureDocument());
    expect(serializeWhiteboardDocumentV3(persisted)).toBe(
      serializeWhiteboardDocumentV3(
        JSON.parse(JSON.stringify(persisted)) as unknown as typeof persisted,
      ),
    );
    expect(() =>
      parseWhiteboardDocumentV3({ ...persisted, futureField: true }),
    ).toThrow(/Unknown field/);
    expect(() =>
      parseWhiteboardDocumentV3({
        ...persisted,
        elements: [persisted.elements[0], persisted.elements[0]],
      }),
    ).toThrow(/Duplicate element id/);
    expect(() =>
      parseWhiteboardDocumentV3({
        ...persisted,
        elements: [
          persisted.elements[0],
          {
            ...persisted.elements[0],
            id: "duplicate-index",
          },
        ],
      }),
    ).toThrow(/Duplicate element index/);
  });

  it("migrates V2 external assets without losing references", () => {
    const migrated = migrateWhiteboardDocumentV2(
      createWhiteboardDocumentV2({
        elements: [
          {
            ...legacyRectangle(),
            type: "image",
            fileId: "external",
          },
        ],
        assets: {
          external: {
            id: "external",
            storage: "external",
            mimeType: "image/png",
            created: 1,
          },
        },
        metadata: {
          name: "Migrated",
          theme: "light",
          viewBackgroundColor: "#ffffff",
          gridSize: null,
        },
      }),
    );
    expect(migrated.version).toBe(3);
    expect(migrated.elements[0]).toMatchObject({ fileId: "external" });
    expect(migrated.assets.external).toMatchObject({
      storage: "external",
      revision: 1,
    });
  });

  it("queries regular and oversized elements through the spatial grid", () => {
    const index = new OwnedSpatialIndex();
    index.insert("inside", { minX: 10, minY: 10, maxX: 20, maxY: 20 });
    index.insert("outside", {
      minX: 10_000,
      minY: 10_000,
      maxX: 10_020,
      maxY: 10_020,
    });
    index.insert("oversized", {
      minX: -10_000,
      minY: -10_000,
      maxX: 10_000,
      maxY: 10_000,
    });
    expect([
      ...index.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
    ]).toEqual(expect.arrayContaining(["inside", "oversized"]));
    expect(index.getDiagnostics().oversizedElements).toBe(1);
  });

  it("enforces byte-aware raster budgets and canvas caps", () => {
    const cache = new OwnedRasterCache(800);
    const first = {};
    const second = {};
    const variant = {
      theme: "light" as const,
      pixelRatio: 1,
      zoom: 1,
      assetRevision: 0,
      boundTextNonce: 0,
      frameOpacity: 100,
    };
    const value = (source: HTMLCanvasElement) => ({
      source,
      pixelWidth: 10,
      pixelHeight: 10,
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 10,
      sceneHeight: 10,
    });
    expect(
      cache.set(first, variant, value(document.createElement("canvas"))),
    ).toBe(true);
    expect(cache.get(first, variant)).not.toBeNull();
    expect(
      cache.set(second, variant, value(document.createElement("canvas"))),
    ).toBe(true);
    expect(cache.getDiagnostics()).toMatchObject({ entries: 2, bytes: 800 });
    expect(isRasterSizeAllowed(OWNED_RASTER_MAX_AREA + 1, 1)).toBe(false);
  });

  it("keeps gesture drafts out of document subscribers and patch history", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(fixtureDocument());
    store.setSelection(["shape"]);
    const listener = vi.fn();
    store.subscribeDocument(listener);
    const before = store.getDocument();
    const element = store.getSelectedElements()[0]!;
    store.beginElementGesture("move");
    store.updateElementGesture([{ ...element, x: 100 }]);
    expect(store.getDocument()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    store.commitElementGesture();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 1,
      undoKinds: ["move"],
    });
    expect(store.getHistoryDiagnostics().bytes).toBeGreaterThan(0);
  });

  it("buffers 2,000 freedraw points in fixed chunks without replacing session", () => {
    const session = beginOwnedDrawing("freedraw", { x: 0, y: 0 });
    for (let index = 1; index < 2_000; index += 1) {
      expect(updateOwnedDrawing(session, { x: index, y: index % 7 })).toBe(
        session,
      );
    }
    expect(session.pointCount).toBe(2_000);
    expect(session.chunks.length).toBe(
      Math.ceil(2_000 / OWNED_FREEDRAW_CHUNK_SIZE),
    );
    expect(materializeDrawingPoints(session)).toHaveLength(2_000);
  });
});

function fixtureDocument(): OwnedWhiteboardDocument {
  const shape = createOwnedDrawingElement(
    updateOwnedDrawing(beginOwnedDrawing("rectangle", { x: 0, y: 0 }), {
      x: 40,
      y: 30,
    }),
    STYLE,
    "shape",
  )!;
  return {
    elements: [shape],
    assets: {},
    state: {
      name: "V3",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}

function legacyRectangle() {
  return {
    id: "legacy",
    isDeleted: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    strokeColor: "#111111",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 1,
    strokeStyle: "solid" as const,
    opacity: 100,
    roughness: 1,
    locked: false,
  };
}
