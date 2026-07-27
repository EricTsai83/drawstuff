import { describe, expect, it, vi } from "vitest";
import type {
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@drawstuff/whiteboard";
import {
  OwnedWhiteboardRenderer,
  OwnedWhiteboardStore,
  type OwnedAnimationScheduler,
} from "@drawstuff/whiteboard";
import { OWNED_CANVAS_PERFORMANCE_FIXTURES } from "../fixtures/owned-canvas/performance";

describe("owned whiteboard renderer", () => {
  it("scales both backing canvases for DPR and redraws only while dirty", () => {
    const harness = createRenderer();
    harness.renderer.resize(320, 180, 2);

    expect(harness.sceneCanvas).toMatchObject({
      width: 640,
      height: 360,
    });
    expect(harness.overlayCanvas).toMatchObject({
      width: 640,
      height: 360,
    });
    expect(harness.scheduler.pending()).toBe(1);
    harness.scheduler.flush();
    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.sceneContext.clearRect).toHaveBeenCalledOnce();
    expect(harness.overlayContext.clearRect).toHaveBeenCalledOnce();

    harness.scheduler.flush();
    expect(harness.sceneContext.clearRect).toHaveBeenCalledOnce();
    harness.renderer.resize(480, 240, 1.5);
    expect(harness.sceneCanvas).toMatchObject({
      width: 720,
      height: 360,
    });
    expect(harness.scheduler.pending()).toBe(1);
  });

  it.each(OWNED_CANVAS_PERFORMANCE_FIXTURES)(
    "records a deterministic $name paint baseline",
    ({ document, expectedElementCount, expectedPaintedCount }) => {
      const harness = createRenderer();
      harness.store.loadDocument(document);
      harness.renderer.resize(1200, 800, 1);

      const stats = harness.renderer.renderNow();

      expect(stats).toEqual({
        visitedElements: expectedElementCount,
        paintedElements: expectedPaintedCount,
        selectedElements: 0,
      });
      harness.renderer.destroy();
      harness.store.destroy();
    },
  );

  it("renders selection separately without changing the document", () => {
    const harness = createRenderer();
    const whiteboardDocument = createDocument([rectangle("selected")]);
    harness.store.loadDocument(whiteboardDocument);
    const documentBeforeSelection = harness.store.getDocument();
    harness.renderer.resize(300, 200, 1);
    harness.renderer.renderNow();
    harness.sceneContext.clearRect.mockClear();
    harness.overlayContext.clearRect.mockClear();
    harness.store.setSelection(["selected"]);

    const stats = harness.renderer.renderNow();

    expect(stats.selectedElements).toBe(1);
    expect(harness.store.getDocument()).toBe(documentBeforeSelection);
    expect(harness.sceneContext.clearRect).not.toHaveBeenCalled();
    expect(harness.overlayContext.clearRect).toHaveBeenCalledOnce();
    expect(harness.overlayContext.strokeRect).toHaveBeenCalled();
  });

  it("renders one shared selection box with resize and rotation handles", () => {
    const harness = createRenderer();
    harness.store.loadDocument(
      createDocument([
        rectangle("first"),
        { ...rectangle("second"), x: 130, y: 40 },
      ]),
    );
    harness.renderer.resize(400, 240, 1);
    harness.renderer.renderNow();
    harness.overlayContext.fillRect.mockClear();
    harness.overlayContext.strokeRect.mockClear();
    harness.store.setSelection(["first", "second"]);

    expect(harness.renderer.renderNow().selectedElements).toBe(2);
    expect(harness.overlayContext.strokeRect).toHaveBeenCalledWith(
      10,
      20,
      220,
      70,
    );
    expect(harness.overlayContext.fillRect).toHaveBeenCalledTimes(9);
    expect(harness.overlayContext.moveTo).toHaveBeenCalledWith(120, 20);
    expect(harness.overlayContext.lineTo).toHaveBeenCalledWith(120, -4);

    harness.overlayContext.fillRect.mockClear();
    harness.overlayContext.strokeRect.mockClear();
    harness.renderer.setEditingEnabled(false);
    harness.renderer.renderNow();
    expect(harness.overlayContext.fillRect).not.toHaveBeenCalled();
    expect(harness.overlayContext.strokeRect).toHaveBeenCalledTimes(1);
  });

  it("renders transient previews only on the overlay canvas", () => {
    const harness = createRenderer();
    harness.renderer.resize(300, 200, 1);
    harness.renderer.renderNow();
    harness.sceneContext.clearRect.mockClear();
    harness.overlayContext.clearRect.mockClear();
    harness.overlayContext.rect.mockClear();

    harness.renderer.setPreview(rectangle("preview"));
    harness.renderer.renderNow();

    expect(harness.sceneContext.clearRect).not.toHaveBeenCalled();
    expect(harness.overlayContext.clearRect).toHaveBeenCalledOnce();
    expect(harness.overlayContext.bezierCurveTo).toHaveBeenCalled();
    expect(harness.overlayContext.scale).toHaveBeenCalledWith(1, 1);
    expect(harness.overlayContext.translate).toHaveBeenCalledWith(0, 0);
  });

  it("reuses rough shapes across viewport renders and invalidates changed elements", () => {
    const harness = createRenderer();
    harness.store.loadDocument(
      createDocument([
        rectangle("cached"),
        {
          ...rectangle("freehand"),
          type: "freedraw",
          points: [
            [0, 0],
            [30, 20],
            [60, 10],
          ],
        },
      ]),
    );
    harness.renderer.resize(300, 200, 1);
    harness.renderer.renderNow();
    expect(harness.renderer.getDiagnostics().roughShapeGenerations).toBe(1);
    expect(harness.renderer.getDiagnostics().freeDrawShapeGenerations).toBe(1);

    harness.store.updateViewport({ x: 12 });
    harness.renderer.renderNow();
    expect(harness.renderer.getDiagnostics().roughShapeGenerations).toBe(1);
    expect(harness.renderer.getDiagnostics().freeDrawShapeGenerations).toBe(1);

    harness.store.setSelection(["cached"]);
    harness.store.updateElementStyle({ roughness: 2 });
    harness.renderer.renderNow();
    expect(harness.renderer.getDiagnostics().roughShapeGenerations).toBe(2);
    expect(harness.renderer.getDiagnostics().freeDrawShapeGenerations).toBe(1);
  });

  it("does not create image requests for non-inline asset URLs", () => {
    const harness = createRenderer();
    harness.store.loadDocument({
      elements: [
        {
          ...rectangle("external-image"),
          type: "image",
          fileId: "external",
        },
      ],
      assets: {
        external: {
          id: "external",
          dataURL: "https://attacker.example/tracking.png",
          mimeType: "image/png",
          created: 1,
        },
      },
      state: {
        name: "",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });

    harness.renderer.renderNow();

    expect(harness.renderer.getDiagnostics().cachedAssets).toBe(0);
    expect(harness.sceneContext.drawImage).not.toHaveBeenCalled();
  });

  it("keeps a stable placeholder after an inline image fails to decode", async () => {
    const createdSources: string[] = [];
    class FailedImage {
      public complete = false;
      public naturalWidth = 0;
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;

      public set src(value: string) {
        if (!value) return;
        createdSources.push(value);
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailedImage);
    const harness = createRenderer();
    harness.store.loadDocument({
      elements: [
        {
          ...rectangle("failed-image"),
          type: "image",
          fileId: "failed",
        },
      ],
      assets: {
        failed: {
          id: "failed",
          dataURL: "data:image/png;base64,AA==",
          mimeType: "image/png",
          created: 1,
        },
      },
      state: {
        name: "",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });

    harness.renderer.renderNow();
    await Promise.resolve();
    harness.renderer.renderNow();

    expect(createdSources).toEqual(["data:image/png;base64,AA=="]);
    expect(harness.sceneContext.drawImage).not.toHaveBeenCalled();
    expect(harness.sceneContext.fillRect).toHaveBeenCalledWith(0, 0, 100, 50);
    expect(harness.sceneContext.strokeRect).toHaveBeenCalledWith(0, 0, 100, 50);
  });

  it("cancels an outstanding render if the engine is destroyed first", () => {
    const harness = createRenderer();
    harness.store.destroy();

    expect(() => harness.scheduler.flush()).not.toThrow();
    expect(harness.renderer.getDiagnostics().scheduled).toBe(false);
  });

  it("releases scheduled frames, subscriptions, and cached image references on destroy", () => {
    const harness = createRenderer();
    harness.store.loadDocument({
      elements: [
        {
          ...rectangle("image"),
          type: "image",
          fileId: "asset",
        },
      ],
      assets: {
        asset: {
          id: "asset",
          dataURL: "data:image/png;base64,AA==",
          mimeType: "image/png",
          created: 1,
        },
      },
      state: {
        name: "",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });
    harness.renderer.resize(300, 200, 1);
    harness.renderer.renderNow();
    expect(harness.renderer.getDiagnostics().cachedAssets).toBe(1);
    harness.store.updateViewport({ x: 20 });
    expect(harness.renderer.getDiagnostics().scheduled).toBe(true);

    harness.renderer.destroy();

    expect(harness.renderer.getDiagnostics()).toMatchObject({
      scheduled: false,
      cachedAssets: 0,
    });
    expect(harness.scheduler.cancel).toHaveBeenCalled();
    const requestCount = harness.scheduler.request.mock.calls.length;
    harness.store.updateViewport({ x: 40 });
    expect(harness.scheduler.request).toHaveBeenCalledTimes(requestCount);
  });
});

function createRenderer() {
  const sceneCanvas = document.createElement("canvas");
  const overlayCanvas = document.createElement("canvas");
  const sceneContext = context();
  const overlayContext = context();
  vi.spyOn(sceneCanvas, "getContext").mockReturnValue(
    sceneContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(overlayCanvas, "getContext").mockReturnValue(
    overlayContext as unknown as CanvasRenderingContext2D,
  );
  const scheduler = animationScheduler();
  const store = new OwnedWhiteboardStore();
  const renderer = new OwnedWhiteboardRenderer(
    sceneCanvas,
    overlayCanvas,
    store,
    scheduler,
  );
  return {
    sceneCanvas,
    overlayCanvas,
    sceneContext,
    overlayContext,
    scheduler,
    store,
    renderer,
  };
}

function animationScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => callbacks.delete(id));
  return {
    request,
    cancel,
    flush: () => {
      const scheduled = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of scheduled) callback(performance.now());
    },
    pending: () => callbacks.size,
  } satisfies OwnedAnimationScheduler & {
    readonly request: typeof request;
    readonly cancel: typeof cancel;
    readonly flush: () => void;
    readonly pending: () => number;
  };
}

function context() {
  return {
    beginPath: vi.fn(),
    bezierCurveTo: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    translate: vi.fn(),
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineDashOffset: 0,
    strokeStyle: "",
    textBaseline: "top",
  };
}

function createDocument(
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

function rectangle(id: string): WhiteboardElement {
  return {
    id,
    type: "rectangle",
    isDeleted: false,
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
  } as unknown as WhiteboardElement;
}
