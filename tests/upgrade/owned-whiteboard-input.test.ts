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

  it("supports keyboard pan and removes every registered listener on destroy", () => {
    const target = document.createElement("div");
    const addListener = vi.spyOn(target, "addEventListener");
    const removeListener = vi.spyOn(target, "removeEventListener");
    const store = new OwnedWhiteboardStore();
    const setMarquee = vi.fn();
    const sink: OwnedInteractionSink = { setMarquee };
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

function setup(elements: readonly WhiteboardElement[]) {
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
  const sink = { setMarquee: vi.fn() };
  const input = new OwnedWhiteboardInput(target, store, sink);
  return { target, store, sink, input };
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
  } as unknown as WhiteboardElement;
}
