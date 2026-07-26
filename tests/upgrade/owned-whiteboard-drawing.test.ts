import { describe, expect, it, vi } from "vitest";
import type {
  WhiteboardDocument,
  WhiteboardElementStyle,
} from "@/features/whiteboard";
import {
  beginOwnedDrawing,
  createOwnedDrawingElement,
  createOwnedTextElement,
  OwnedWhiteboardInput,
  OwnedWhiteboardStore,
  OwnedWhiteboardTextEditor,
  updateOwnedDrawing,
  type OwnedDrawingTool,
  type OwnedInteractionSink,
  type PointerEventLike,
} from "@/features/whiteboard/owned";

const STYLE: WhiteboardElementStyle = {
  strokeColor: "#1971c2",
  backgroundColor: "#d0ebff",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "dashed",
  opacity: 80,
  roughness: 1,
};

describe("owned drawing element geometry", () => {
  it.each([
    ["rectangle", { x: -20, y: -10, width: 30, height: 30 }],
    ["ellipse", { x: -20, y: -10, width: 30, height: 30 }],
    ["diamond", { x: -20, y: -10, width: 30, height: 30 }],
    [
      "line",
      {
        x: -20,
        y: -10,
        width: 30,
        height: 30,
        points: [
          [30, 30],
          [0, 0],
        ],
      },
    ],
    [
      "arrow",
      {
        x: -20,
        y: -10,
        width: 30,
        height: 30,
        points: [
          [30, 30],
          [0, 0],
        ],
      },
    ],
  ] satisfies readonly [OwnedDrawingTool, Readonly<Record<string, unknown>>][])(
    "normalizes reverse-direction %s geometry",
    (tool, expected) => {
      const element = drawing(tool, [
        { x: 10, y: 20 },
        { x: -20, y: -10 },
      ]);

      expect(element).toMatchObject({
        id: `${tool}-id`,
        type: tool,
        isDeleted: false,
        angle: 0,
        strokeColor: "#1971c2",
        backgroundColor:
          tool === "line" || tool === "arrow" ? "transparent" : "#d0ebff",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "dashed",
        opacity: 80,
        roughness: 1,
        ...expected,
      });
    },
  );

  it("snapshots free draw and multiline text in owned geometry", () => {
    const freeDraw = drawing("freedraw", [
      { x: -15, y: 8 },
      { x: -4, y: -2 },
      { x: 5, y: 12 },
    ]);
    const text = createOwnedTextElement(
      { x: -40, y: 12 },
      "first\n\nthird",
      STYLE,
      "text-id",
    );

    expect({
      freeDraw,
      text,
    }).toMatchInlineSnapshot(`
      {
        "freeDraw": {
          "angle": 0,
          "backgroundColor": "transparent",
          "fillStyle": "solid",
          "height": 14,
          "id": "draw-id",
          "isDeleted": false,
          "opacity": 80,
          "points": [
            [
              0,
              10,
            ],
            [
              11,
              0,
            ],
            [
              20,
              14,
            ],
          ],
          "roughness": 1,
          "seed": 1264129047,
          "strokeColor": "#1971c2",
          "strokeStyle": "dashed",
          "strokeWidth": 2,
          "type": "freedraw",
          "width": 20,
          "x": -15,
          "y": -2,
        },
        "text": {
          "angle": 0,
          "backgroundColor": "transparent",
          "fillStyle": "solid",
          "fontSize": 20,
          "height": 75,
          "id": "text-id",
          "isDeleted": false,
          "lineHeight": 1.25,
          "opacity": 80,
          "originalText": "first

      third",
          "roughness": 1,
          "seed": 924750060,
          "strokeColor": "#1971c2",
          "strokeStyle": "dashed",
          "strokeWidth": 2,
          "text": "first

      third",
          "type": "text",
          "width": 60,
          "x": -40,
          "y": 12,
        },
      }
    `);
  });

  it("rejects whitespace-only text and accepts measured editor dimensions", () => {
    expect(
      createOwnedTextElement({ x: 0, y: 0 }, " \n ", STYLE, "empty"),
    ).toBeNull();
    expect(
      createOwnedTextElement({ x: 0, y: 0 }, "wide", STYLE, "measured", {
        width: 47,
        height: 26,
      }),
    ).toMatchObject({ width: 47, height: 26, text: "wide" });
  });

  it("commits tiny and off-canvas geometry but rejects click-only gestures", () => {
    const tiny = drawing("rectangle", [
      { x: -1000, y: -500 },
      { x: -999.99, y: -499.99 },
    ]);
    expect(tiny).toMatchObject({
      x: -1000,
      y: -500,
    });
    expect(tiny?.width).toBeCloseTo(0.01);
    expect(tiny?.height).toBeCloseTo(0.01);
    expect(
      createOwnedDrawingElement(
        beginOwnedDrawing("line", { x: 4, y: 8 }),
        STYLE,
        "click",
      ),
    ).toBeNull();
  });
});

describe("owned drawing interactions", () => {
  it.each([
    ["mouse", "rectangle"],
    ["touch", "arrow"],
    ["pen", "freedraw"],
  ] as const)(
    "keeps a %s %s preview transient and commits one undoable mutation",
    (pointerType, tool) => {
      const harness = setup();
      harness.store.setActiveTool({ type: tool });
      const listener = vi.fn();
      harness.store.subscribeDocument(listener);

      harness.target.dispatchEvent(
        pointerEvent("pointerdown", {
          pointerType,
          clientX: 10,
          clientY: 20,
        }),
      );
      harness.target.dispatchEvent(
        pointerEvent("pointermove", {
          pointerType,
          clientX: 50,
          clientY: 70,
        }),
      );

      expect(harness.store.getDocument().elements).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
      expect(harness.sink.setPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: tool }),
      );

      harness.target.dispatchEvent(
        pointerEvent("pointerup", {
          pointerType,
          clientX: 50,
          clientY: 70,
        }),
      );

      expect(listener).toHaveBeenCalledOnce();
      expect(harness.store.getDocument().elements).toHaveLength(1);
      expect(harness.store.getActiveTool().type).toBe("selection");
      harness.store.undo();
      expect(harness.store.getDocument().elements).toEqual([]);
      harness.store.redo();
      expect(harness.store.getDocument().elements).toHaveLength(1);
      harness.input.destroy();
    },
  );

  it.each([
    "rectangle",
    "ellipse",
    "diamond",
    "line",
    "arrow",
    "freedraw",
  ] as const)("does not persist a click-only %s gesture", (tool) => {
    const harness = setup();
    harness.store.setActiveTool({ type: tool });
    const listener = vi.fn();
    harness.store.subscribeDocument(listener);

    harness.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 20 }),
    );
    harness.target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 10, clientY: 20 }),
    );

    expect(harness.store.getDocument().elements).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    harness.input.destroy();
  });

  it("ignores a different mouse button released during a left-button drag", () => {
    const harness = setup();
    harness.store.setActiveTool({ type: "rectangle" });
    harness.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 20, button: 0 }),
    );
    harness.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 50, clientY: 70 }),
    );
    harness.target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 50, clientY: 70, button: 2 }),
    );
    expect(harness.store.getDocument().elements).toEqual([]);

    harness.target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 50, clientY: 70, button: 0 }),
    );
    expect(harness.store.getDocument().elements).toHaveLength(1);
    harness.input.destroy();
  });

  it("clears a drawing preview when middle-button pan takes over", () => {
    const harness = setup();
    harness.store.setActiveTool({ type: "rectangle" });
    harness.target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 20 }),
    );
    harness.target.dispatchEvent(
      pointerEvent("pointermove", { clientX: 50, clientY: 70 }),
    );
    harness.target.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: 50,
        clientY: 70,
        button: 1,
      }),
    );

    expect(harness.sink.setPreview).toHaveBeenLastCalledWith(null);
    harness.target.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 50,
        clientY: 70,
        button: 1,
      }),
    );
    expect(harness.store.getDocument().elements).toEqual([]);
    harness.input.destroy();
  });

  it.each(["pointercancel", "lostpointercapture", "Escape"] as const)(
    "cancels an in-progress gesture on %s without persistence",
    (cancelAction) => {
      const harness = setup();
      harness.store.setActiveTool({ type: "rectangle" });
      harness.target.dispatchEvent(
        pointerEvent("pointerdown", { clientX: 10, clientY: 20 }),
      );
      harness.target.dispatchEvent(
        pointerEvent("pointermove", { clientX: 80, clientY: 90 }),
      );
      if (cancelAction === "Escape") {
        harness.target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        harness.target.dispatchEvent(
          pointerEvent(cancelAction, { clientX: 80, clientY: 90 }),
        );
      }

      expect(harness.store.getDocument().elements).toEqual([]);
      expect(harness.sink.setPreview).toHaveBeenLastCalledWith(null);
      harness.input.destroy();
    },
  );

  it("lets an individual capability flag disable a tool without disabling selection", () => {
    const target = document.createElement("div");
    const store = new OwnedWhiteboardStore();
    store.loadDocument(emptyDocument());
    store.setActiveTool({ type: "arrow" });
    const sink = {
      setMarquee: vi.fn(),
      setPreview: vi.fn(),
      beginTextEditing: vi.fn(),
    } satisfies OwnedInteractionSink;
    const input = new OwnedWhiteboardInput(target, store, sink, {
      arrow: false,
      diamond: true,
      ellipse: true,
      freedraw: true,
      line: true,
      rectangle: true,
      text: true,
    });

    target.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 20 }),
    );
    target.dispatchEvent(
      pointerEvent("pointerup", { clientX: 50, clientY: 70 }),
    );

    expect(store.getDocument().elements).toEqual([]);
    expect(sink.setPreview).not.toHaveBeenCalled();
    input.destroy();
  });

  it("supports multiline text blur commit and Escape cancellation through an HTML editor", () => {
    const root = document.createElement("div");
    document.body.append(root);
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 510,
      bottom: 420,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    Object.defineProperties(root, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const store = new OwnedWhiteboardStore();
    store.resizeViewport(500, 400, 10, 20);
    store.updateViewport({ x: 5, y: 10, zoom: 2 });
    store.loadDocument(emptyDocument());
    store.updateViewport({ x: 5, y: 10, zoom: 2 });
    store.setActiveTool({ type: "text" });
    let textId = 0;
    const editor = new OwnedWhiteboardTextEditor(
      root,
      store,
      () => `text-${++textId}`,
    );
    const sink = {
      setMarquee: vi.fn(),
      setPreview: vi.fn(),
      beginTextEditing: (point) => editor.begin(point),
    } satisfies OwnedInteractionSink;
    const input = new OwnedWhiteboardInput(root, store, sink);

    root.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 110, clientY: 120 }),
    );
    const textarea = root.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.style.left).toBe("100px");
    expect(textarea?.style.top).toBe("100px");
    expect(textarea?.style.transform).toBe("scale(2)");
    store.panBy(20, 0, true);
    expect(textarea?.style.left).toBe("120px");
    textarea!.value = "first\n\nthird";
    textarea!.dispatchEvent(new FocusEvent("blur"));

    expect(store.getDocument().elements[0]).toMatchObject({
      id: "text-1",
      type: "text",
      text: "first\n\nthird",
      x: 45,
      y: 40,
    });

    store.setActiveTool({ type: "text" });
    root.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 200, clientY: 180 }),
    );
    const cancelled = root.querySelector("textarea");
    cancelled!.value = "discard me";
    cancelled!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements).toHaveLength(1);
    expect(root.querySelector("textarea")).toBeNull();

    store.setActiveTool({ type: "text" });
    root.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 240, clientY: 220 }),
    );
    const keyboardCommitted = root.querySelector("textarea");
    keyboardCommitted!.value = "keyboard commit";
    keyboardCommitted!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getDocument().elements.at(-1)).toMatchObject({
      type: "text",
      text: "keyboard commit",
    });

    input.destroy();
    editor.destroy();
    store.destroy();
    root.remove();
  });
});

function drawing(
  tool: OwnedDrawingTool,
  points: readonly { readonly x: number; readonly y: number }[],
) {
  let session = beginOwnedDrawing(tool, points[0]!);
  for (const point of points.slice(1)) {
    session = updateOwnedDrawing(session, point);
  }
  const id = tool === "freedraw" ? "draw-id" : `${tool}-id`;
  return createOwnedDrawingElement(session, STYLE, id);
}

function setup() {
  const target = document.createElement("div");
  Object.defineProperties(target, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  const store = new OwnedWhiteboardStore();
  store.resizeViewport(500, 400, 0, 0);
  store.loadDocument(emptyDocument());
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
    () => "created-id",
  );
  return { target, store, sink, input };
}

function emptyDocument(): WhiteboardDocument {
  return {
    elements: [],
    assets: {},
    state: {
      name: "",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}

function pointer(update: Partial<PointerEventLike> = {}): PointerEventLike {
  return {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 0,
    clientY: 0,
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
