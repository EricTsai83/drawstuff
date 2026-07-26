import { describe, expect, it, vi } from "vitest";
import type {
  WhiteboardDocument,
  WhiteboardElement,
} from "@/features/whiteboard";
import {
  documentToScreen,
  OWNED_MAX_ZOOM,
  OWNED_MIN_ZOOM,
  OwnedWhiteboardStore,
} from "@/features/whiteboard/owned";

describe("owned whiteboard store", () => {
  it("implements viewport clamping, center zooming, reset, and fit-to-content", () => {
    const store = new OwnedWhiteboardStore();
    store.resizeViewport(1000, 500, 20, 30);
    store.loadDocument(document([rectangle("shape", 0, 0, 100, 50)]));

    store.updateViewport({ zoom: Number.POSITIVE_INFINITY });
    expect(store.getViewport().zoom).toBe(1);
    store.updateViewport({ zoom: 1000 });
    expect(store.getViewport().zoom).toBe(OWNED_MAX_ZOOM);
    store.updateViewport({ zoom: 0.0001 });
    expect(store.getViewport().zoom).toBe(OWNED_MIN_ZOOM);
    store.updateViewport({ zoom: 1, x: 0, y: 0 });

    const centerBefore = documentToScreen(
      { x: 10, y: 20 },
      store.getViewport(),
    );
    store.zoomAt(centerBefore, 2);
    expect(documentToScreen({ x: 10, y: 20 }, store.getViewport())).toEqual(
      centerBefore,
    );

    store.fitToContent();
    const viewport = store.getViewport();
    const topLeft = documentToScreen({ x: 0, y: 0 }, viewport);
    const bottomRight = documentToScreen({ x: 100, y: 50 }, viewport);
    expect(topLeft.x).toBeGreaterThanOrEqual(viewport.offsetX);
    expect(topLeft.y).toBeGreaterThanOrEqual(viewport.offsetY);
    expect(bottomRight.x).toBeLessThanOrEqual(
      viewport.offsetX + viewport.width,
    );
    expect(bottomRight.y).toBeLessThanOrEqual(
      viewport.offsetY + viewport.height,
    );
    expect(store.getDocument().state).toMatchObject({
      scrollX: viewport.x,
      scrollY: viewport.y,
      zoom: { value: viewport.zoom },
    });
  });

  it("exposes selection as editor state without mutating or notifying the document", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        rectangle("selectable", 0, 0, 10, 10),
        rectangle("locked", 20, 0, 10, 10, { locked: true }),
      ]),
    );
    const before = store.getDocument();
    const documentListener = vi.fn();
    const editorListener = vi.fn();
    store.subscribeDocument(documentListener);
    store.subscribeEditorState(editorListener);

    store.setSelection(["selectable", "locked", "missing"]);

    expect(store.getEditorState().selectedElementIds).toEqual(["selectable"]);
    expect(store.getDocument()).toBe(before);
    expect(documentListener).not.toHaveBeenCalled();
    expect(editorListener).toHaveBeenCalledOnce();
  });

  it("keeps pointer-pan viewport updates off public editor subscriptions until commit", () => {
    const store = new OwnedWhiteboardStore();
    const editorListener = vi.fn();
    store.subscribeEditorState(editorListener);

    store.panBy(10, 5, true);
    store.panBy(10, 5, true);
    expect(editorListener).not.toHaveBeenCalled();

    store.commitTransientViewport();
    expect(editorListener).toHaveBeenCalledOnce();
    expect(store.getViewport()).toMatchObject({ x: 20, y: 10 });
  });

  it("undoes a selected-element style change before undoing its creation", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([]));
    store.appendElement(rectangle("created", 0, 0, 10, 10));
    store.updateElementStyle({ strokeColor: "#e03131", roughness: 2 });

    expect(store.getDocument().elements[0]).toMatchObject({
      strokeColor: "#e03131",
      roughness: 2,
    });
    expect(store.getEditorState().elementStyle.roughness).toBe(2);
    store.undo();
    expect(store.getDocument().elements[0]).toMatchObject({
      strokeColor: "#1e1e1e",
    });
    store.undo();
    expect(store.getDocument().elements).toEqual([]);
  });

  it("does not add an undo entry for an identical selected-element style", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([]));
    store.appendElement(rectangle("created", 0, 0, 10, 10));
    const listener = vi.fn();
    store.subscribeDocument(listener);

    store.updateElementStyle({ strokeColor: "#1e1e1e" });

    expect(listener).not.toHaveBeenCalled();
    store.undo();
    expect(store.getDocument().elements).toEqual([]);
  });

  it("round-trips an owned document export through import", async () => {
    const source = new OwnedWhiteboardStore();
    source.loadDocument(
      document([rectangle("persisted", 4, 8, 16, 32)], {
        name: "Owned export",
        theme: "dark",
      }),
    );
    const blob = await source.exportDocument();
    const target = new OwnedWhiteboardStore();

    const result = await target.importDocument(blob);

    expect(result.name).toBe("Owned export");
    expect(target.getDocument().elements[0]?.id).toBe("persisted");
    expect(target.getEditorState().theme).toBe("dark");
  });

  it("inserts, deduplicates, selects, and undoes owned images", async () => {
    const store = new OwnedWhiteboardStore();
    store.resizeViewport(1000, 500, 0, 0);
    const image = new Blob([pngBytes(320, 180)], { type: "image/png" });

    await store.insertImage(image);
    const first = store.getDocument();
    expect(first.elements[0]).toMatchObject({
      type: "image",
      width: 320,
      height: 180,
      x: 340,
      y: 160,
    });
    expect(Object.keys(first.assets)).toHaveLength(1);
    expect(store.getEditorState().selectedElementIds).toEqual([
      first.elements[0]?.id,
    ]);

    store.beginElementGesture("move");
    store.updateElementGesture([
      { ...first.elements[0]!, x: Number(first.elements[0]?.x) + 20 },
    ]);
    await store.insertImage(image);
    expect(store.getDocument().elements).toHaveLength(2);
    expect(Object.keys(store.getAssets())).toHaveLength(1);
    expect(store.getDocument().elements[1]?.fileId).toBe(
      first.elements[0]?.fileId,
    );

    store.undo();
    expect(store.getDocument().elements).toHaveLength(1);
    store.undo();
    expect(store.getDocument().elements[0]?.x).toBe(340);
    store.undo();
    expect(store.getDocument().elements).toEqual([]);
  });

  it("normalizes lenient legacy imports into an exportable snapshot while retaining late asset recovery", async () => {
    const store = new OwnedWhiteboardStore();
    const legacyBlob = new Blob([
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [
          {
            id: "duplicate",
            type: "image",
            isDeleted: false,
            fileId: "late-asset",
            x: 0,
            y: 0,
            width: 20,
            height: 20,
          },
          {
            id: "duplicate",
            type: "rectangle",
            isDeleted: false,
            x: 30,
            y: 0,
            width: 20,
            height: 20,
          },
        ],
        appState: { name: "Lenient legacy import" },
        files: {
          "late-asset": {
            id: "late-asset",
            dataURL: "https://invalid.example/image.png",
            mimeType: "text/html",
            created: 1,
          },
        },
      }),
    ]);

    await store.importDocument(legacyBlob);

    expect(store.getDocument().elements).toHaveLength(2);
    expect(store.getDocument().elements.map((element) => element.id)).toEqual([
      "duplicate",
      "legacy-1",
    ]);
    expect(store.getDocument().elements[0]?.fileId).toBeNull();
    const exported = JSON.parse(
      await (await store.exportDocument()).text(),
    ) as {
      readonly version: number;
      readonly elements: readonly WhiteboardElement[];
      readonly assets: Readonly<Record<string, unknown>>;
    };
    expect(exported.version).toBe(1);
    expect(exported.elements).toHaveLength(2);
    expect(exported.assets).toEqual({});

    store.addAssets([
      {
        id: "late-asset",
        dataURL: "data:image/png;base64,AA==",
        mimeType: "image/png",
        created: 1,
      },
    ]);
    expect(store.getDocument().elements[0]?.fileId).toBe("late-asset");
    expect(store.getAssets()).toHaveProperty("late-asset");
  });

  it("clears subscriptions and rejects use after destroy", () => {
    const store = new OwnedWhiteboardStore();
    const listener = vi.fn();
    store.subscribeEditorState(listener);
    store.destroy();

    expect(() => store.getViewport()).toThrow("destroyed");
    expect(listener).not.toHaveBeenCalled();
  });
});

function document(
  elements: readonly WhiteboardElement[],
  state?: Partial<WhiteboardDocument["state"]>,
): WhiteboardDocument {
  return {
    elements,
    assets: {},
    state: {
      name: "",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
      ...state,
    },
  };
}

function rectangle(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  update: Readonly<Record<string, unknown>> = {},
): WhiteboardElement {
  return {
    id,
    type: "rectangle",
    isDeleted: false,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    ...update,
  } as unknown as WhiteboardElement;
}

function pngBytes(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.buffer;
}
