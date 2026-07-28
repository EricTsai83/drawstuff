import { describe, expect, it } from "vitest";
import type {
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@drawstuff/whiteboard";
import {
  getResizedBounds,
  getSelectionBounds,
  OwnedWhiteboardStore,
  resizeElements,
  resizeElementsUniformly,
  rotateElements,
  translateElements,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../helpers";

const EDITABLE_ELEMENT_TYPES = [
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
] as const;

describe("owned whiteboard editing transforms", () => {
  it.each(EDITABLE_ELEMENT_TYPES)(
    "moves, resizes, and rotates %s elements with finite non-negative geometry",
    (type) => {
      const original = editableElement(type);
      const source = getSelectionBounds([original])!;
      const moved = translateElements([original], { x: 15, y: -5 })[0]!;
      const resized = resizeElements([original], source, {
        minX: 10,
        minY: 20,
        maxX: 210,
        maxY: 120,
      })[0]!;
      const rotated = rotateElements(
        [original],
        { x: 50, y: 25 },
        Math.PI / 2,
      )[0]!;

      expect(moved).toMatchObject({ x: 15, y: -5 });
      expect(resized).toMatchObject({
        x: 10,
        y: 20,
        width: 200,
        height: 100,
      });
      expect(rotated.angle).toBeCloseTo(Math.PI / 2);
      for (const value of [
        resized.x,
        resized.y,
        resized.width,
        resized.height,
        rotated.x,
        rotated.y,
        rotated.angle,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(resized.width).toBeGreaterThanOrEqual(0);
      expect(resized.height).toBeGreaterThanOrEqual(0);
    },
  );

  it("scales linear points and text metrics with the selection", () => {
    const line = editableElement("line");
    const text = editableElement("text");

    const [resizedLine, resizedText] = resizeElements(
      [line, text],
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      { minX: 0, minY: 0, maxX: 200, maxY: 150 },
    );

    expect(
      resizedLine && "points" in resizedLine ? resizedLine.points : undefined,
    ).toEqual([
      [0, 0],
      [200, 150],
    ]);
    expect(
      resizedText?.type === "text" ? resizedText.fontSize : undefined,
    ).toBe(60);
  });

  it("resizes rotated elements uniformly from the opposite anchor", () => {
    const rotated = { ...editableElement("rectangle"), angle: Math.PI / 2 };
    const source = getSelectionBounds([rotated])!;
    const target = getResizedBounds(
      source,
      "e",
      { x: source.maxX + 100, y: 25 },
      true,
    );

    const resized = resizeElementsUniformly([rotated], source, target, "e")[0]!;
    const resizedBounds = getSelectionBounds([resized])!;

    expect(resized.angle).toBeCloseTo(Math.PI / 2);
    expect(resizedBounds.minX).toBeCloseTo(source.minX);
    expect(resizedBounds.maxX).toBeCloseTo(source.maxX + 100);
    expect(resized.width / resized.height).toBeCloseTo(2);
  });

  it("preserves aspect ratio with Shift semantics and prevents handle crossing", () => {
    const source = { minX: 0, minY: 0, maxX: 100, maxY: 50 };

    expect(getResizedBounds(source, "se", { x: 250, y: 80 }, true)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 250,
      maxY: 125,
    });
    const crossed = getResizedBounds(source, "nw", { x: 500, y: 500 }, false);
    expect(crossed.maxX - crossed.minX).toBeGreaterThanOrEqual(1);
    expect(crossed.maxY - crossed.minY).toBeGreaterThanOrEqual(1);
    const nonFinite = getResizedBounds(
      source,
      "se",
      { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      false,
    );
    expect(Object.values(nonFinite).every(Number.isFinite)).toBe(true);
  });
});

describe("owned whiteboard semantic history", () => {
  it("coalesces a pointer gesture into one command and restores it atomically", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([editableElement("rectangle")]));
    store.setSelection(["rectangle"]);
    const selected = store.getSelectedElements();
    let documentEmissions = 0;
    store.subscribeDocument(() => {
      documentEmissions += 1;
    });

    store.beginElementGesture("move");
    store.updateElementGesture(translateElements(selected, { x: 10, y: 10 }));
    store.updateElementGesture(translateElements(selected, { x: 30, y: 20 }));
    store.commitElementGesture();

    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 1,
      undoKinds: ["move"],
    });
    expect(documentEmissions).toBe(1);
    expect(store.getDocument().elements[0]).toMatchObject({ x: 30, y: 20 });
    store.undo();
    expect(store.getDocument().elements[0]).toMatchObject({ x: 0, y: 0 });
    store.redo();
    expect(store.getDocument().elements[0]).toMatchObject({ x: 30, y: 20 });
  });

  it("clears redo after branching and excludes load boundaries from history", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([]));
    store.appendElement(editableElement("rectangle", "first"));
    store.appendElement(editableElement("ellipse", "second"));
    store.undo();
    store.appendElement(editableElement("diamond", "branch"));
    store.redo();
    expect(store.getDocument().elements.map((element) => element.id)).toEqual([
      "first",
      "branch",
    ]);

    store.loadDocument(document([editableElement("text", "loaded")]));
    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 0,
      redoEntries: 0,
    });
    store.undo();
    expect(store.getDocument().elements[0]?.id).toBe("loaded");
  });

  it("enforces the explicit entry limit", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([]));
    for (let index = 0; index < 105; index += 1) {
      store.appendElement(editableElement("rectangle", `element-${index}`));
    }
    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 100,
      limit: 100,
    });
    for (let index = 0; index < 100; index += 1) store.undo();
    expect(store.getDocument().elements).toHaveLength(5);
  });

  it("keeps system asset/theme synchronization and empty operations out of history", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        {
          ...editableElement("image", "image"),
          fileId: "remote",
        } as WhiteboardElement,
      ]),
    );

    expect(store.createClipboardPayload()).toBeNull();
    store.beginElementGesture("move");
    store.deleteSelection();
    store.appendElement(editableElement("rectangle", "created"));
    store.undo();
    store.addAssets([
      {
        id: "remote",
        dataURL: "data:image/png;base64,AA==",
        mimeType: "image/png",
        created: 1,
      },
    ]);
    store.updateEditorState({ theme: "dark" });

    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 0,
      redoEntries: 1,
    });
    store.redo();
    expect(store.getEditorState().theme).toBe("dark");
    expect(store.getAssets()).toHaveProperty("remote");
    const restored = store.getDocument().elements[0];
    expect(restored?.type).toBe("image");
    expect(restored?.type === "image" ? restored.fileId : undefined).toBe(
      "remote",
    );
  });
});

function editableElement(
  type: (typeof EDITABLE_ELEMENT_TYPES)[number],
  id: string = type,
): WhiteboardElement {
  const common = {
    id,
    type,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 1,
    strokeStyle: "solid" as const,
    opacity: 100,
    roughness: 1,
    locked: false,
  };
  if (type === "image")
    return createTestElementV3({ ...common, type, fileId: null });
  if (type === "text") {
    return createTestElementV3({
      ...common,
      type,
      text: "Editable",
      originalText: "Editable",
      fontSize: 20,
      lineHeight: 1.25,
    });
  }
  if (type === "line" || type === "arrow" || type === "freedraw") {
    return createTestElementV3({
      ...common,
      type,
      points: [
        [0, 0],
        [100, 50],
      ],
    });
  }
  return createTestElementV3({ ...common, type });
}

function document(
  elements: readonly WhiteboardElement[],
): OwnedWhiteboardDocument {
  return {
    elements,
    assets: {},
    state: {
      name: "",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}
