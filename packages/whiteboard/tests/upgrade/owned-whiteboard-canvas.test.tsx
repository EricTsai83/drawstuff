import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  OwnedWhiteboardDocument,
  WhiteboardEngine,
  WhiteboardViewerController,
} from "@drawstuff/whiteboard";
import { OwnedWhiteboardCanvas } from "@drawstuff/whiteboard";

describe("OwnedWhiteboardCanvas lifecycle", () => {
  it("loads an owned document and releases RAF, observer, engine, and canvas resources", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const frame = nextFrame;
      nextFrame += 1;
      callbacks.set(frame, callback);
      return frame;
    });
    const cancelAnimationFrame = vi.fn((frame: number) =>
      callbacks.delete(frame),
    );
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    let measured = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 12,
        y: 24,
        left: 12,
        top: 24,
        right: measured ? 412 : 12,
        bottom: measured ? 324 : 24,
        width: measured ? 400 : 0,
        height: measured ? 300 : 0,
        toJSON: () => ({}),
      }),
    );
    const disconnect = vi.fn();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver implements ResizeObserver {
      public constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      public observe(): void {
        // Initial sizing is performed synchronously by the component.
      }
      public unobserve(): void {
        // No individual unobserve is expected during this lifecycle.
      }
      public disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    let engine: WhiteboardEngine | null = null;
    const onEngineReady = vi.fn((nextEngine: WhiteboardEngine | null) => {
      engine = nextEngine;
    });
    const sourceDocument = ownedDocument();
    const { unmount, container, rerender } = render(
      <OwnedWhiteboardCanvas
        document={sourceDocument}
        onEngineReady={onEngineReady}
      />,
    );

    await waitFor(() => {
      expect(engine?.getDocument().elements[0]?.id).toBe("owned-shape");
    });
    const readyEngine = onEngineReady.mock.calls.find(
      ([candidate]) => candidate !== null,
    )?.[0];
    expect(readyEngine?.getViewport().width).toBe(0);
    measured = true;
    resizeCallbacks.at(-1)?.([], {} as ResizeObserver);
    for (const callback of [...callbacks.values()]) callback(performance.now());
    callbacks.clear();

    expect(container.querySelectorAll("canvas")).toHaveLength(2);
    expect(context.rect).toHaveBeenCalled();
    expect(readyEngine?.getViewport()).toMatchObject({
      width: 400,
      height: 300,
      offsetX: 12,
      offsetY: 24,
    });
    expect(readyEngine?.getViewport().x).toBeLessThan(-3000);
    vi.stubGlobal("devicePixelRatio", 2);
    window.dispatchEvent(new Event("resize"));
    expect(container.querySelector("canvas")?.width).toBe(800);

    rerender(
      <OwnedWhiteboardCanvas
        document={sourceDocument}
        drawingCapabilities={{ arrow: false }}
        onEngineReady={onEngineReady}
      />,
    );
    expect(onEngineReady).not.toHaveBeenCalledWith(null);
    expect(
      onEngineReady.mock.calls.filter(([candidate]) => candidate !== null),
    ).toHaveLength(1);

    let replacementEngine: WhiteboardEngine | null = null;
    const replacementReady = vi.fn(
      (nextEngine: WhiteboardEngine | null): void => {
        replacementEngine = nextEngine;
      },
    );
    rerender(
      <OwnedWhiteboardCanvas
        document={sourceDocument}
        onEngineReady={replacementReady}
      />,
    );
    await waitFor(() => {
      expect(replacementEngine?.getDocument().elements[0]?.id).toBe(
        "owned-shape",
      );
    });
    const loadError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    rerender(
      <OwnedWhiteboardCanvas
        document={Promise.reject(new Error("load failed"))}
        onEngineReady={replacementReady}
      />,
    );
    await waitFor(() => {
      expect(loadError).toHaveBeenCalledWith(
        "Failed to load owned whiteboard document",
        expect.any(Error),
      );
    });

    unmount();

    expect(replacementReady).toHaveBeenLastCalledWith(null);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });

  it("exposes only navigation methods to read-only viewers", async () => {
    let controller: WhiteboardViewerController | null = null;
    const onViewerReady = vi.fn((next: WhiteboardViewerController | null) => {
      controller = next;
    });
    const view = render(
      <OwnedWhiteboardCanvas
        document={ownedDocument()}
        editingEnabled={false}
        onViewerReady={onViewerReady}
      />,
    );

    await waitFor(() => expect(controller).not.toBeNull());
    expect(Object.keys(controller!)).toEqual([
      "getViewport",
      "subscribeViewport",
      "updateViewport",
      "fitToContent",
    ]);
    expect(controller).not.toHaveProperty("loadDocument");
    expect(controller).not.toHaveProperty("clearDocument");
    expect(controller).not.toHaveProperty("addAssets");

    view.unmount();
    expect(onViewerReady).toHaveBeenLastCalledWith(null);
  });
});

function ownedDocument(): OwnedWhiteboardDocument {
  return {
    elements: [
      {
        id: "owned-shape",
        type: "rectangle",
        isDeleted: false,
        x: 4000,
        y: 20,
        width: 100,
        height: 50,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        opacity: 100,
        roughness: 1,
        locked: false,
      },
    ],
    assets: {},
    state: {
      name: "Owned canvas",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}

function canvasContext() {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
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
    strokeStyle: "",
    textBaseline: "top",
  };
}
