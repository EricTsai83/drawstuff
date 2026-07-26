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

    expect(store.getDocument().elements).toHaveLength(1);
    expect(store.getDocument().elements[0]?.fileId).toBeNull();
    const exported = JSON.parse(
      await (await store.exportDocument()).text(),
    ) as {
      readonly version: number;
      readonly elements: readonly WhiteboardElement[];
      readonly assets: Readonly<Record<string, unknown>>;
    };
    expect(exported.version).toBe(1);
    expect(exported.elements).toHaveLength(1);
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
