import { describe, expect, it, vi } from "vitest";
import type {
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@drawstuff/whiteboard";
import {
  applyOwnedDarkModeFilter,
  exportOwnedWhiteboardSvg,
  OWNED_DARK_THEME_FILTER,
  OwnedWhiteboardRenderer,
  OwnedWhiteboardStore,
  OwnedWhiteboardTextEditor,
  type OwnedAnimationScheduler,
} from "@drawstuff/whiteboard";

describe("owned whiteboard Excalidraw theme parity", () => {
  it.each([
    ["#000000", "#ededed"],
    ["#ffffff", "#121212"],
    ["#1e1e1e", "#d3d3d3"],
    ["#ff0000", "#ff9090"],
    ["rgba(255, 0, 0, 0.5)", "#ff909080"],
    ["transparent", "#ededed00"],
  ])("maps %s through the Excalidraw dark filter", (source, expected) => {
    expect(applyOwnedDarkModeFilter(source)).toBe(expected);
    expect(applyOwnedDarkModeFilter(source, false)).toBe(source);
  });

  it("renders the dark background and element colors without changing stored colors", () => {
    const document = createDocument("dark");
    const svg = exportOwnedWhiteboardSvg(document, { format: "svg" });

    expect(svg).toContain('fill="#121212"');
    expect(svg).toContain('stroke="#d3d3d3"');
    expect(document.elements[0]?.strokeColor).toBe("#1e1e1e");
    expect(
      exportOwnedWhiteboardSvg(document, {
        format: "svg",
        exportWithDarkMode: false,
      }),
    ).toContain('stroke="#1e1e1e"');
  });

  it("updates the interactive overlay and active text editor when theme changes", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(createDocument("light"));
    const sceneCanvas = document.createElement("canvas");
    const overlayCanvas = document.createElement("canvas");
    const sceneContext = createCanvasContext();
    const overlayContext = createCanvasContext();
    vi.spyOn(sceneCanvas, "getContext").mockReturnValue(
      sceneContext as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(overlayCanvas, "getContext").mockReturnValue(
      overlayContext as unknown as CanvasRenderingContext2D,
    );
    const renderer = new OwnedWhiteboardRenderer(
      sceneCanvas,
      overlayCanvas,
      store,
      immediateScheduler,
    );
    const root = document.createElement("div");
    document.body.append(root);
    const textEditor = new OwnedWhiteboardTextEditor(root, store);
    textEditor.begin({ x: 0, y: 0 });

    expect(root.querySelector("textarea")?.style.color).toBe("rgb(30, 30, 30)");
    store.updateEditorState({ theme: "dark" });
    renderer.renderNow();

    expect(overlayCanvas.style.filter).toBe(OWNED_DARK_THEME_FILTER);
    expect(root.querySelector("textarea")?.style.color).toBe(
      "rgb(211, 211, 211)",
    );
    expect(store.getDocument().elements[0]?.strokeColor).toBe("#1e1e1e");

    textEditor.destroy();
    renderer.destroy();
    store.destroy();
    root.remove();
  });
});

const immediateScheduler: OwnedAnimationScheduler = {
  request: () => 1,
  cancel: () => undefined,
};

function createDocument(theme: "dark" | "light"): OwnedWhiteboardDocument {
  return {
    elements: [rectangle()],
    assets: {},
    state: {
      name: "Theme",
      theme,
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}

function rectangle(): WhiteboardElement {
  return {
    id: "rectangle",
    type: "rectangle",
    isDeleted: false,
    x: 0,
    y: 0,
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
  };
}

function createCanvasContext() {
  return {
    beginPath: () => undefined,
    clearRect: () => undefined,
    closePath: () => undefined,
    drawImage: () => undefined,
    ellipse: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    lineTo: () => undefined,
    moveTo: () => undefined,
    rect: () => undefined,
    restore: () => undefined,
    rotate: () => undefined,
    save: () => undefined,
    scale: () => undefined,
    setLineDash: () => undefined,
    setTransform: () => undefined,
    stroke: () => undefined,
    strokeRect: () => undefined,
    translate: () => undefined,
    fillStyle: "",
    filter: "none",
    font: "",
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: "",
    textBaseline: "top",
  };
}
