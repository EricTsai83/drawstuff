import { describe, expect, it, vi } from "vitest";
import type {
  WhiteboardDocument,
  WhiteboardElement,
} from "@/features/whiteboard";
import {
  normalizePointerEvent,
  OwnedWhiteboardInput,
  OwnedWhiteboardStore,
  screenToDocument,
  type OwnedInteractionSink,
  type PointerEventLike,
} from "@/features/whiteboard/owned";

describe("owned whiteboard pointer input", () => {
  it.each([
    ["mouse", 1, 0, 0.5],
    ["touch", 1, 0.75, 0.75],
    ["pen", 1, 0.35, 0.35],
  ])(
    "normalizes %s coordinates and pressure",
    (pointerType, buttons, pressure, expectedPressure) => {
      const normalized = normalizePointerEvent(
        pointer({ pointerType, buttons, pressure }),
      );

      expect(normalized.type).toBe(pointerType);
      expect(normalized.point).toEqual({ x: 120, y: 80 });
      expect(normalized.pressure).toBe(expectedPressure);
      expect(normalized.primary).toBe(true);
    },
  );

  it("selects the topmost unlocked element and completes marquee selection", () => {
    const { target, store, sink, input } = setup([
      rectangle("first", 0, 0, 50, 50),
      rectangle("top", 0, 0, 50, 50),
      rectangle("locked", 60, 0, 20, 20, { locked: true }),
      rectangle("marquee", 85, 85, 20, 20),
    ]);

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }),
    );
    expect(store.getEditorState().selectedElementIds).toEqual(["top"]);

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 55, clientY: 55 }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 110, clientY: 110 }),
    );
    target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 110, clientY: 110 }),
    );

    expect(store.getEditorState().selectedElementIds).toEqual(["marquee"]);
    expect(sink.setMarquee).toHaveBeenLastCalledWith(null);
    input.destroy();
  });

  it("keeps selection clear when a zero-area marquee follows a shape-aware miss", () => {
    const { target, store, input } = setup([
      rectangle("ellipse", 0, 0, 100, 60, { type: "ellipse" }),
    ]);

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 1, clientY: 1 }),
    );
    target.dispatchEvent(pointerEvent("pointerup", { clientX: 1, clientY: 1 }));

    expect(store.getEditorState().selectedElementIds).toEqual([]);
    input.destroy();
  });

  it("refreshes the viewport offset before hit testing a moved canvas", () => {
    const { target, store, input } = setup([
      rectangle("offset-shape", 0, 0, 50, 50),
    ]);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 600,
      bottom: 450,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 110, clientY: 60 }),
    );

    expect(store.getViewport()).toMatchObject({ offsetX: 100, offsetY: 50 });
    expect(store.getEditorState().selectedElementIds).toEqual(["offset-shape"]);
    input.destroy();
  });

  it("lets a single touch select while the hand tool still pans transiently", () => {
    const selectionSetup = setup([rectangle("touch-shape", 0, 0, 50, 50)]);
    selectionSetup.target.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerType: "touch",
        clientX: 10,
        clientY: 10,
      }),
    );
    expect(selectionSetup.store.getEditorState().selectedElementIds).toEqual([
      "touch-shape",
    ]);
    selectionSetup.input.destroy();

    const { target, store, input } = setup([]);
    store.setActiveTool({ type: "hand" });
    const listener = vi.fn();
    store.subscribeEditorState(listener);

    target.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
      }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", {
        pointerType: "touch",
        clientX: 125,
        clientY: 115,
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    target.dispatchEvent(
      pointerEvent("pointerup", {
        pointerType: "touch",
        clientX: 125,
        clientY: 115,
      }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(store.getViewport()).toMatchObject({ x: 25, y: 15 });
    input.destroy();
  });

  it("normalizes wheel delta modes and commits one editor update after the burst", () => {
    vi.useFakeTimers();
    const { target, store, input } = setup([]);
    const listener = vi.fn();
    store.subscribeEditorState(listener);
    const anchor = { x: 100, y: 80 };
    const documentAnchor = screenToDocument(anchor, store.getViewport());

    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 2,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(store.getViewport().y).toBe(-32);
    expect(listener).not.toHaveBeenCalled();
    target.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: anchor.x,
        clientY: anchor.y,
        deltaY: -10,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const anchoredAfterZoom = screenToDocument(anchor, store.getViewport());
    expect(anchoredAfterZoom.x).toBeCloseTo(documentAnchor.x);
    expect(anchoredAfterZoom.y).toBeCloseTo(documentAnchor.y + 32);
    vi.advanceTimersByTime(120);
    expect(listener).toHaveBeenCalledOnce();

    input.destroy();
    vi.useRealTimers();
  });

  it("commits cancelled pans and clears an Escape-cancelled marquee", () => {
    const panSetup = setup([]);
    panSetup.store.setActiveTool({ type: "hand" });
    const editorListener = vi.fn();
    panSetup.store.subscribeEditorState(editorListener);
    panSetup.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }),
    );
    panSetup.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 30, clientY: 20 }),
    );
    panSetup.target.dispatchEvent(
      pointerEvent("pointercancel", { clientX: 30, clientY: 20 }),
    );
    expect(editorListener).toHaveBeenCalledOnce();
    expect(panSetup.store.getViewport()).toMatchObject({ x: 20, y: 10 });
    panSetup.input.destroy();

    const marqueeSetup = setup([]);
    marqueeSetup.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }),
    );
    marqueeSetup.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 80, clientY: 80 }),
    );
    marqueeSetup.target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(marqueeSetup.sink.setMarquee).toHaveBeenLastCalledWith(null);
    expect(marqueeSetup.store.getEditorState().selectedElementIds).toEqual([]);
    marqueeSetup.input.destroy();
  });

  it("uses held Space as a temporary pan control", () => {
    const { target, store, input } = setup([]);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Space",
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 25, clientY: 30 }),
    );
    target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 25, clientY: 30 }),
    );

    expect(store.getViewport()).toMatchObject({ x: 15, y: 20 });
    input.destroy();
  });

  it("adds and removes elements with platform selection modifiers while excluding locked elements", () => {
    const { target, store, input } = setup([
      rectangle("first", 0, 0, 40, 40),
      rectangle("second", 60, 0, 40, 40),
      rectangle("locked", 120, 0, 40, 40, { locked: true }),
    ]);

    click(target, 20, 20);
    click(target, 80, 20, { shiftKey: true });
    expect(store.getEditorState().selectedElementIds).toEqual([
      "first",
      "second",
    ]);
    click(target, 20, 20, { metaKey: true });
    expect(store.getEditorState().selectedElementIds).toEqual(["second"]);

    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getEditorState().selectedElementIds).toEqual([
      "first",
      "second",
    ]);
    input.destroy();
  });

  it("toggles marquee selections with Shift and Ctrl modifiers", () => {
    const { target, store, input } = setup([
      rectangle("first", 0, 0, 40, 40),
      rectangle("second", 60, 0, 40, 40),
    ]);
    store.setSelection(["first"]);

    drag(target, { x: 55, y: -5 }, { x: 105, y: 45 }, { shiftKey: true });
    expect(store.getEditorState().selectedElementIds).toEqual([
      "first",
      "second",
    ]);
    drag(target, { x: -10, y: -10 }, { x: 45, y: 45 }, { ctrlKey: true });
    expect(store.getEditorState().selectedElementIds).toEqual(["second"]);
    input.destroy();
  });

  it("moves a shared selection in one undoable pointer gesture", () => {
    const { target, store, input } = setup([
      rectangle("first", 0, 0, 40, 40),
      rectangle("second", 60, 0, 40, 40),
    ]);
    store.setSelection(["first", "second"]);

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 20, clientY: 20 }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 35, clientY: 30 }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 50, clientY: 45 }),
    );
    target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 50, clientY: 45 }),
    );

    expect(store.getDocument().elements).toMatchObject([
      { x: 30, y: 25 },
      { x: 90, y: 25 },
    ]);
    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 1,
      undoKinds: ["move"],
    });
    store.undo();
    expect(store.getDocument().elements).toMatchObject([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
    ]);
    input.destroy();
  });

  it("finalizes a transform before Delete so undo order remains semantic", () => {
    const { target, store, input } = setup([rectangle("shape", 0, 0, 40, 40)]);
    store.setSelection(["shape"]);
    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 20, clientY: 20 }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 40, clientY: 40 }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 40, clientY: 40 }),
    );

    expect(store.getHistoryDiagnostics().undoKinds).toEqual(["move", "delete"]);
    store.undo();
    expect(store.getDocument().elements[0]).toMatchObject({ x: 20, y: 20 });
    store.undo();
    expect(store.getDocument().elements[0]).toMatchObject({ x: 0, y: 0 });
    input.destroy();
  });

  it("cancels, commits, or escapes active transforms at input boundaries", () => {
    const cancelled = setup([rectangle("shape", 0, 0, 40, 40)]);
    cancelled.store.setSelection(["shape"]);
    cancelled.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 20, clientY: 20 }),
    );
    cancelled.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 40, clientY: 40 }),
    );
    cancelled.target.dispatchEvent(
      pointerEvent("pointercancel", { clientX: 40, clientY: 40 }),
    );
    expect(cancelled.store.getDocument().elements[0]).toMatchObject({
      x: 0,
      y: 0,
    });
    cancelled.input.destroy();

    const captured = setup([rectangle("shape", 0, 0, 100, 50)]);
    captured.store.setSelection(["shape"]);
    captured.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 100, clientY: 50 }),
    );
    captured.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 150, clientY: 75 }),
    );
    captured.target.dispatchEvent(
      pointerEvent("lostpointercapture", { clientX: 150, clientY: 75 }),
    );
    expect(captured.store.getHistoryDiagnostics().undoKinds).toEqual([
      "resize",
    ]);
    captured.input.destroy();

    const escaped = setup([rectangle("shape", 0, 0, 100, 50)]);
    escaped.store.setSelection(["shape"]);
    escaped.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 50, clientY: -24 }),
    );
    escaped.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 100, clientY: 25 }),
    );
    escaped.target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(escaped.store.getDocument().elements[0]?.angle).toBe(0);
    expect(escaped.store.getHistoryDiagnostics().undoEntries).toBe(0);
    escaped.input.destroy();
  });

  it("resizes from directional handles and rotates around the selection center", () => {
    const resizeSetup = setup([rectangle("shape", 0, 0, 100, 50)]);
    resizeSetup.store.setSelection(["shape"]);
    resizeSetup.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 100, clientY: 50 }),
    );
    resizeSetup.target.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 200,
        clientY: 80,
        shiftKey: true,
      }),
    );
    resizeSetup.target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 200, clientY: 80 }),
    );
    expect(resizeSetup.store.getDocument().elements[0]).toMatchObject({
      width: 200,
      height: 100,
    });
    resizeSetup.input.destroy();

    const rotateSetup = setup([rectangle("shape", 0, 0, 100, 50)]);
    rotateSetup.store.setSelection(["shape"]);
    rotateSetup.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 50, clientY: -24 }),
    );
    rotateSetup.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 100, clientY: 25 }),
    );
    rotateSetup.target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 100, clientY: 25 }),
    );
    expect(rotateSetup.store.getDocument().elements[0]?.angle).toBeCloseTo(
      Math.PI / 2,
    );
    rotateSetup.input.destroy();
  });

  it("supports Windows/Linux and macOS history, duplicate, delete, and editable-target guards", () => {
    const { target, store, input } = setup([rectangle("shape", 0, 0, 40, 40)]);
    store.setSelection(["shape"]);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(2);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(1);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(2);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(1);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "y",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(2);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(0);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(2);
    store.setSelection(["shape"]);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(1);

    const field = document.createElement("input");
    target.append(field);
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getEditorState().selectedElementIds).toEqual([]);
    input.destroy();
  });

  it("coalesces repeated Shift-arrow nudges into one history entry", () => {
    const { target, store, input } = setup([rectangle("shape", 0, 0, 40, 40)]);
    store.setSelection(["shape"]);
    for (let index = 0; index < 2; index += 1) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          repeat: index > 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    target.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
      }),
    );

    expect(store.getDocument().elements[0]?.x).toBe(20);
    expect(store.getHistoryDiagnostics()).toMatchObject({
      undoEntries: 1,
      undoKinds: ["move"],
    });
    input.destroy();
  });

  it("copies, cuts, and repeatedly pastes versioned payloads with a plain-text fallback", () => {
    let id = 0;
    const { target, store, input } = setup(
      [rectangle("shape", 0, 0, 40, 40)],
      () => `generated-${++id}`,
    );
    store.setSelection(["shape"]);
    const clipboard = clipboardData();

    target.dispatchEvent(clipboardEvent("copy", clipboard));
    expect(
      clipboard.getData("application/x-drawstuff-whiteboard+json"),
    ).toContain('"version":1');
    target.dispatchEvent(clipboardEvent("paste", clipboard));
    target.dispatchEvent(clipboardEvent("paste", clipboard));
    expect(store.getDocument().elements.map((element) => element.x)).toEqual([
      0, 20, 40,
    ]);
    expect(
      new Set(store.getDocument().elements.map((element) => element.id)).size,
    ).toBe(3);

    const plainOnly = clipboardData();
    plainOnly.setData("text/plain", clipboard.getData("text/plain"));
    target.dispatchEvent(clipboardEvent("paste", plainOnly));
    expect(store.getDocument().elements).toHaveLength(4);
    target.dispatchEvent(clipboardEvent("cut", clipboard));
    expect(store.getDocument().elements).toHaveLength(3);

    store.setSelection([store.getDocument().elements[0]!.id]);
    const textarea = document.createElement("textarea");
    target.append(textarea);
    const typingClipboard = clipboardData();
    textarea.dispatchEvent(clipboardEvent("copy", typingClipboard));
    textarea.dispatchEvent(clipboardEvent("cut", typingClipboard));
    expect(typingClipboard.getData("text/plain")).toBe("");
    expect(store.getDocument().elements).toHaveLength(3);
    input.destroy();
  });

  it("can disable Phase 5F editing while retaining read-only selection and navigation", () => {
    const { target, store, input } = setup([rectangle("shape", 0, 0, 40, 40)]);
    input.setEditingEnabled(false);
    click(target, 20, 20);
    expect(store.getEditorState().selectedElementIds).toEqual(["shape"]);

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 20, clientY: 20 }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 80, clientY: 80 }),
    );
    target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 80, clientY: 80 }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(store.getDocument().elements[0]).toMatchObject({ x: 0, y: 0 });
    expect(store.getDocument().elements).toHaveLength(1);
    input.destroy();
  });

  it("cancels an in-flight transform when editing is disabled", () => {
    const { target, store, input } = setup([rectangle("shape", 0, 0, 40, 40)]);
    store.setSelection(["shape"]);
    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 20, clientY: 20 }),
    );
    target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 80, clientY: 80 }),
    );

    input.setEditingEnabled(false);

    expect(store.getDocument().elements[0]).toMatchObject({ x: 0, y: 0 });
    expect(store.getHistoryDiagnostics().undoEntries).toBe(0);
    input.destroy();
  });

  it("does not cut an oversized whiteboard payload", () => {
    const { target, store, input } = setup([
      rectangle("shape", 0, 0, 40, 40, {
        text: "界".repeat(1_700_000),
      }),
    ]);
    store.setSelection(["shape"]);
    const clipboard = clipboardData();

    target.dispatchEvent(clipboardEvent("cut", clipboard));

    expect(clipboard.getData("text/plain")).toBe("");
    expect(store.getDocument().elements).toHaveLength(1);
    input.destroy();
  });

  it("supports keyboard pan and removes every registered listener on destroy", () => {
    const target = document.createElement("div");
    const addListener = vi.spyOn(target, "addEventListener");
    const removeListener = vi.spyOn(target, "removeEventListener");
    const store = new OwnedWhiteboardStore();
    const setMarquee = vi.fn();
    const sink = {
      setMarquee,
      setPreview: vi.fn(),
      beginTextEditing: vi.fn(),
    } satisfies OwnedInteractionSink;
    const input = new OwnedWhiteboardInput(target, store, sink);

    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getViewport().x).toBe(-40);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "0",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getViewport().x).toBe(-40);
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Space",
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(new FocusEvent("blur"));
    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 200, clientY: 200 }),
    );
    expect(setMarquee).toHaveBeenLastCalledWith(expect.any(Object));

    input.destroy();
    const addedEventTypes = addListener.mock.calls.map(([type]) => type).sort();
    const removedEventTypes = removeListener.mock.calls
      .map(([type]) => type)
      .sort();
    expect(removedEventTypes).toEqual(addedEventTypes);
  });
});

function setup(
  elements: readonly WhiteboardElement[],
  createId?: () => string,
) {
  const target = document.createElement("div");
  Object.defineProperties(target, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  const store = new OwnedWhiteboardStore();
  store.resizeViewport(500, 400, 0, 0);
  const whiteboardDocument: WhiteboardDocument = {
    elements,
    assets: {},
    state: {
      name: "",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
  store.loadDocument(whiteboardDocument);
  const sink = {
    setMarquee: vi.fn(),
    setPreview: vi.fn(),
    beginTextEditing: vi.fn(),
  } satisfies OwnedInteractionSink;
  const input = new OwnedWhiteboardInput(
    target,
    store,
    sink,
    undefined,
    createId,
  );
  return { target, store, sink, input };
}

function click(
  target: HTMLElement,
  clientX: number,
  clientY: number,
  modifiers: Partial<PointerEventLike> = {},
): void {
  target.dispatchEvent(
    pointerEvent("pointerdown", { clientX, clientY, ...modifiers }),
  );
  target.dispatchEvent(
    pointerEvent("pointerup", { clientX, clientY, ...modifiers }),
  );
}

function drag(
  target: HTMLElement,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  modifiers: Partial<PointerEventLike> = {},
): void {
  target.dispatchEvent(
    pointerEvent("pointerdown", {
      clientX: start.x,
      clientY: start.y,
      ...modifiers,
    }),
  );
  target.dispatchEvent(
    pointerEvent("pointermove", {
      clientX: end.x,
      clientY: end.y,
      ...modifiers,
    }),
  );
  target.dispatchEvent(
    pointerEvent("pointerup", {
      clientX: end.x,
      clientY: end.y,
      ...modifiers,
    }),
  );
}

function clipboardData() {
  const values = new Map<string, string>();
  return {
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  };
}

function clipboardEvent(
  type: "copy" | "cut" | "paste",
  data: ReturnType<typeof clipboardData>,
): ClipboardEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: data,
  });
  return event as ClipboardEvent;
}

function pointer(update: Partial<PointerEventLike> = {}): PointerEventLike {
  return {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 120,
    clientY: 80,
    pressure: 0,
    buttons: 1,
    isPrimary: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...update,
  };
}

function pointerEvent(
  type: string,
  update: Partial<PointerEventLike> & { readonly button?: number },
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const source = pointer(update);
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: source.pointerId },
    pointerType: { configurable: true, value: source.pointerType },
    clientX: { configurable: true, value: source.clientX },
    clientY: { configurable: true, value: source.clientY },
    pressure: { configurable: true, value: source.pressure },
    buttons: { configurable: true, value: source.buttons },
    isPrimary: { configurable: true, value: source.isPrimary },
    altKey: { configurable: true, value: source.altKey },
    ctrlKey: { configurable: true, value: source.ctrlKey },
    metaKey: { configurable: true, value: source.metaKey },
    shiftKey: { configurable: true, value: source.shiftKey },
    button: { configurable: true, value: update.button ?? 0 },
  });
  return event as PointerEvent;
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
    ...update,
  };
}
