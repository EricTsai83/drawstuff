import { describe, expect, it, vi } from "vitest";
import type {
  OwnedWhiteboardDocument,
  WhiteboardAsset,
  WhiteboardBoxElementV3,
  WhiteboardElement,
  WhiteboardFrameElementV3,
  WhiteboardLinearElementV3,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../helpers";
import {
  documentToScreen,
  OWNED_MAX_ZOOM,
  OWNED_MIN_ZOOM,
  OwnedWhiteboardStore,
} from "@drawstuff/whiteboard";

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

  it("reorders a multi-selection as a stable layer group and supports undo", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        rectangle("back", 0, 0, 10, 10),
        rectangle("selected-a", 20, 0, 10, 10),
        rectangle("middle", 40, 0, 10, 10),
        rectangle("selected-b", 60, 0, 10, 10),
        rectangle("front", 80, 0, 10, 10),
      ]),
    );
    store.setSelection(["selected-a", "selected-b"]);

    store.reorderSelection("front");
    expect(store.getDocument().elements.map((element) => element.id)).toEqual([
      "back",
      "middle",
      "front",
      "selected-a",
      "selected-b",
    ]);

    store.undo();
    expect(store.getDocument().elements.map((element) => element.id)).toEqual([
      "back",
      "selected-a",
      "middle",
      "selected-b",
      "front",
    ]);

    store.reorderSelection("backward");
    expect(store.getDocument().elements.map((element) => element.id)).toEqual([
      "selected-a",
      "back",
      "selected-b",
      "middle",
      "front",
    ]);
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
    const inserted = store.getDocument().elements[1];
    const original = first.elements[0];
    expect(inserted?.type === "image" ? inserted.fileId : undefined).toBe(
      original?.type === "image" ? original.fileId : undefined,
    );

    store.undo();
    expect(store.getDocument().elements).toHaveLength(1);
    store.undo();
    expect(store.getDocument().elements[0]?.x).toBe(340);
    store.undo();
    expect(store.getDocument().elements).toEqual([]);
  });

  it("keeps bound text, arrow endpoints, and frame membership synchronized in one move", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        v3Rectangle("container", 0, 0, 80, 60),
        v3Frame("frame", 100, 100, 300, 240, 50),
        v3Arrow("arrow", -100, 20, "container"),
      ]),
    );
    store.commitTextEdit({
      targetId: "container",
      point: { x: 0, y: 0 },
      text: "Bound",
      width: 50,
      height: 25,
      createId: () => "bound-text",
    });
    const beforeText = store.getBoundTextForContainer("container");
    expect(beforeText).toMatchObject({
      containerId: "container",
      textAlign: "center",
      verticalAlign: "middle",
    });

    store.setSelection(["container"]);
    store.beginElementGesture("move");
    store.updateElementGesture([
      { ...store.getElement("container")!, x: 150, y: 150 },
    ]);
    expect(
      store.getDocument().elements.find(({ id }) => id === "container"),
    ).toMatchObject({
      x: 0,
      y: 0,
    });
    store.commitElementGesture();

    const container = store.getElement("container");
    const text = store.getBoundTextForContainer("container");
    const arrow = store.getElement("arrow");
    expect(container).toMatchObject({ x: 150, y: 150, frameId: "frame" });
    expect(text).toMatchObject({
      x: (beforeText?.x ?? 0) + 150,
      y: (beforeText?.y ?? 0) + 150,
      frameId: "frame",
    });
    expect(
      arrow?.type === "arrow"
        ? arrow.x + (arrow.points.at(-1)?.[0] ?? 0)
        : Number.NaN,
    ).toBeCloseTo(150);
    expect(store.getRasterCacheDependencies(container!)).toMatchObject({
      boundTextNonce: text?.versionNonce,
      frameOpacity: 50,
    });
    expect(store.getHistoryDiagnostics().undoKinds).toEqual(["text", "move"]);

    store.deleteSelection();
    expect(store.getElement("container")).toBeNull();
    expect(store.getElement("bound-text")).toBeNull();
    expect(store.getElement("arrow")).toMatchObject({ endBinding: null });
    store.undo();
    expect(store.getElement("container")).not.toBeNull();
    expect(store.getBoundTextForContainer("container")).not.toBeNull();
    expect(store.getElement("arrow")).toMatchObject({
      endBinding: { elementId: "container" },
    });
  });

  it("selects groups as a unit, ungroups every member, and moves frame descendants", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        v3Rectangle("group-a", 0, 0, 20, 20, {
          groupIds: ["group-1"],
        }),
        v3Rectangle("group-b", 30, 0, 20, 20, {
          groupIds: ["group-1"],
        }),
        v3Frame("frame", 100, 100, 200, 200),
        v3Rectangle("child", 120, 120, 20, 20, { frameId: "frame" }),
      ]),
    );

    store.setSelection(["group-a"]);
    expect(store.getEditorState().selectedElementIds).toEqual([
      "group-a",
      "group-b",
    ]);
    store.ungroupSelection();
    const groupA = store.getElement("group-a");
    const groupB = store.getElement("group-b");
    expect(groupA && "groupIds" in groupA ? groupA.groupIds : null).toEqual([]);
    expect(groupB && "groupIds" in groupB ? groupB.groupIds : null).toEqual([]);

    store.setSelection(["frame"]);
    const transform = store.getTransformElements("move");
    expect(transform.map(({ id }) => id)).toEqual(["frame", "child"]);
    store.beginElementGesture("move");
    store.updateElementGesture(
      transform.map((element) => ({
        ...element,
        x: element.x + 50,
        y: element.y + 40,
      })),
    );
    store.commitElementGesture();
    expect(store.getElement("frame")).toMatchObject({ x: 150, y: 140 });
    expect(store.getElement("child")).toMatchObject({ x: 170, y: 160 });

    store.commitTextEdit({
      targetId: "child",
      point: { x: 170, y: 160 },
      text: "Child label",
      createId: () => "child-text",
    });
    store.setSelection(["frame"]);
    store.deleteSelection();
    expect(store.getElement("frame")).toBeNull();
    expect(store.getElement("child")).toBeNull();
    expect(store.getElement("child-text")).toBeNull();
  });

  it("edits the innermost nested group without selecting outside members", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        v3Rectangle("outer-only", 0, 0, 20, 20, {
          groupIds: ["outer"],
        }),
        v3Rectangle("inner-a", 30, 0, 20, 20, {
          groupIds: ["outer", "inner"],
        }),
        v3Rectangle("inner-b", 60, 0, 20, 20, {
          groupIds: ["outer", "inner"],
        }),
        v3Rectangle("outside", 90, 0, 20, 20),
      ]),
    );

    expect(store.enterGroupEditing("inner-a")).toBe(true);
    expect(store.getEditorState().selection.editingGroupId).toBe("inner");
    store.setSelection(["inner-a"]);
    expect(store.getEditorState().selectedElementIds).toEqual(["inner-a"]);
    store.setSelection(["outside"]);
    expect(store.getEditorState().selectedElementIds).toEqual([]);
    store.selectAll();
    expect(store.getEditorState().selectedElementIds).toEqual([
      "inner-a",
      "inner-b",
    ]);

    expect(store.exitGroupEditing()).toBe(true);
    expect(store.getEditorState().selection.editingGroupId).toBeNull();
    store.setSelection(["inner-a"]);
    expect(store.getEditorState().selectedElementIds).toEqual([
      "inner-a",
      "inner-b",
    ]);
  });

  it("uses full bounds and deepest nesting when resolving containing frames", () => {
    const store = new OwnedWhiteboardStore();
    const outer = v3Frame("outer", 0, 0, 400, 400);
    const inner = {
      ...v3Frame("inner", 50, 50, 200, 200),
      frameId: "outer",
    };
    const fullyNested = v3Rectangle("fully-nested", 100, 100, 20, 20);
    const partiallyNested = v3Rectangle("partially-nested", 240, 100, 20, 20);
    store.loadDocument(document([outer, inner, fullyNested, partiallyNested]));

    expect(
      store.getContainingFrames(fullyNested).map((frame) => frame.id),
    ).toEqual(["inner", "outer"]);
    expect(
      store.getContainingFrames(partiallyNested).map((frame) => frame.id),
    ).toEqual(["outer"]);

    store.setSelection(["partially-nested"]);
    store.beginElementGesture("move");
    store.updateElementGesture([
      { ...partiallyNested, x: partiallyNested.x + 1 },
    ]);
    store.commitElementGesture();
    expect(store.getElement("partially-nested")).toMatchObject({
      frameId: "outer",
    });
  });

  it("drops an incomplete image asset from serializable snapshots", () => {
    const store = new OwnedWhiteboardStore();
    const incompleteAsset = {
      id: "incomplete",
      dataURL: "data:image/png;base64,AA==",
      mimeType: "image/png",
    } as unknown as WhiteboardAsset;
    store.loadDocument({
      elements: [
        createTestElementV3({
          ...rectangle("image", 0, 0, 10, 10),
          type: "image",
          fileId: "incomplete",
        }),
      ],
      assets: { incomplete: incompleteAsset },
      state: { name: "", theme: "light" },
    });

    expect(store.getDocument().assets).toEqual({});
    expect(store.getDocument().elements[0]).toMatchObject({ fileId: null });
  });

  it("previews a swept eraser once and commits one document/history event", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        rectangle("first", 0, 0, 40, 40),
        rectangle("second", 80, 0, 40, 40),
        rectangle("locked", 160, 0, 40, 40, { locked: true }),
      ]),
    );
    const documentListener = vi.fn();
    const renderListener = vi.fn();
    store.subscribeDocument(documentListener);
    store.subscribeRenderState(renderListener);

    store.beginEraseGesture();
    store.updateEraseGesture({ x: -10, y: 20 }, { x: 130, y: 20 }, 5);
    store.updateEraseGesture({ x: 20, y: 20 }, { x: 20, y: 20 }, 5);

    expect(store.getErasedPreviewElements().map(({ id }) => id)).toEqual([
      "first",
      "second",
    ]);
    expect(documentListener).not.toHaveBeenCalled();
    expect(renderListener).toHaveBeenLastCalledWith("overlay");

    store.commitEraseGesture();

    expect(store.getDocument().elements.map(({ id }) => id)).toEqual([
      "locked",
    ]);
    expect(documentListener).toHaveBeenCalledOnce();
    expect(store.getHistoryDiagnostics().undoKinds).toEqual(["erase"]);
  });

  it("cancels erasing without mutating the document", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([rectangle("shape", 0, 0, 40, 40)]));
    const listener = vi.fn();
    store.subscribeDocument(listener);
    store.beginEraseGesture();
    store.updateEraseGesture({ x: 10, y: 10 }, { x: 30, y: 30 }, 5);

    store.cancelEraseGesture();

    expect(store.getDocument().elements).toHaveLength(1);
    expect(store.getErasedPreviewElements()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects legacy V2 file imports as unsupported", async () => {
    const store = new OwnedWhiteboardStore();
    const malformedBlob = new Blob([
      JSON.stringify({
        version: 2,
        elements: [
          {
            ...rectangle("duplicate", 0, 0, 20, 20),
            fillStyle: "solid",
            roughness: 1,
            locked: false,
          },
          {
            ...rectangle("duplicate", 30, 0, 20, 20),
            fillStyle: "solid",
            roughness: 1,
            locked: false,
          },
        ],
        metadata: {
          name: "Duplicate import",
          theme: "light",
          viewBackgroundColor: "#ffffff",
          gridSize: null,
        },
        assets: {},
      }),
    ]);

    await expect(store.importDocument(malformedBlob)).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
      path: "$.version",
    });
    expect(store.getDocument().elements).toEqual([]);
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
  state?: Partial<OwnedWhiteboardDocument["state"]>,
): OwnedWhiteboardDocument {
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
  return createTestElementV3({
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
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 1,
    locked: false,
    ...update,
  });
}

function v3Rectangle(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  update: Partial<WhiteboardBoxElementV3> = {},
): WhiteboardBoxElementV3 & { readonly type: "rectangle" } {
  return {
    ...rectangle(id, x, y, width, height),
    index: `a-${id}`,
    seed: 1,
    version: 1,
    versionNonce: 1,
    updatedAt: 1,
    groupIds: [],
    frameId: null,
    ...update,
  } as WhiteboardBoxElementV3 & { readonly type: "rectangle" };
}

function v3Frame(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  opacity = 100,
): WhiteboardFrameElementV3 {
  return {
    ...v3Rectangle(id, x, y, width, height),
    type: "frame",
    name: id,
    opacity,
  };
}

function v3Arrow(
  id: string,
  x: number,
  y: number,
  targetId: string,
): WhiteboardLinearElementV3 & { readonly type: "arrow" } {
  return {
    ...v3Rectangle(id, x, y, 100, 1),
    type: "arrow",
    points: [
      [0, 0],
      [100, 0],
    ],
    startArrowhead: null,
    endArrowhead: "arrow",
    startBinding: null,
    endBinding: { elementId: targetId, focus: 0, gap: 0 },
    elbowed: false,
    fixedSegments: [],
  };
}

function pngBytes(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.buffer;
}
