import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WhiteboardDocument,
  WhiteboardEditorState,
  WhiteboardEditorStateUpdate,
  WhiteboardElementStyleUpdate,
  WhiteboardEngine,
  WhiteboardTool,
  WhiteboardViewport,
} from "@/features/whiteboard";
import { WhiteboardShell } from "@/features/whiteboard/ui";

const DOCUMENT: WhiteboardDocument = {
  elements: [{ id: "shape-1", type: "rectangle", isDeleted: false }],
  state: { name: "Test board", theme: "light" },
  assets: {},
};

const INITIAL_STATE: WhiteboardEditorState = {
  activeTool: { type: "selection", locked: false, customType: null },
  viewport: {
    x: 0,
    y: 0,
    zoom: 1,
    width: 1200,
    height: 800,
    offsetX: 0,
    offsetY: 0,
  },
  name: "Test board",
  theme: "light",
  selectedElementIds: ["shape-1"],
  elementStyle: {
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
  },
};

function createTestEngine(initialState = INITIAL_STATE) {
  let state = initialState;
  let document = DOCUMENT;
  const editorListeners = new Set<(value: WhiteboardEditorState) => void>();
  const documentListeners = new Set<(value: WhiteboardDocument) => void>();

  function publishEditorState(): void {
    for (const listener of editorListeners) listener(state);
  }

  const setActiveTool = vi.fn((tool: WhiteboardTool) => {
    state = { ...state, activeTool: tool };
    publishEditorState();
  });
  const updateElementStyle = vi.fn((update: WhiteboardElementStyleUpdate) => {
    state = {
      ...state,
      elementStyle: { ...state.elementStyle, ...update },
    };
    publishEditorState();
  });
  const updateViewport = vi.fn(
    (update: Partial<Pick<WhiteboardViewport, "x" | "y" | "zoom">>) => {
      state = {
        ...state,
        viewport: { ...state.viewport, ...update },
      };
      publishEditorState();
    },
  );
  const fitToContent = vi.fn();
  const undo = vi.fn();
  const clearDocument = vi.fn();
  const exportImage = vi.fn(async () => new Blob(["image"]));
  const importDocument = vi.fn(async () => ({ name: "Imported board" }));

  const engine: WhiteboardEngine = {
    loadDocument: vi.fn((nextDocument: WhiteboardDocument) => {
      document = nextDocument;
      for (const listener of documentListeners) listener(document);
    }),
    getDocument: vi.fn(() => document),
    subscribeDocument: vi.fn(
      (listener: (value: WhiteboardDocument) => void) => {
        documentListeners.add(listener);
        return () => documentListeners.delete(listener);
      },
    ),
    getEditorState: vi.fn(() => state),
    subscribeEditorState: vi.fn(
      (listener: (value: WhiteboardEditorState) => void) => {
        editorListeners.add(listener);
        return () => editorListeners.delete(listener);
      },
    ),
    updateEditorState: vi.fn((update: WhiteboardEditorStateUpdate) => {
      state = { ...state, ...update };
      publishEditorState();
    }),
    getActiveTool: vi.fn(() => state.activeTool),
    setActiveTool,
    updateElementStyle,
    getViewport: vi.fn(() => state.viewport),
    updateViewport,
    fitToContent,
    undo,
    redo: vi.fn(),
    clearDocument,
    addAssets: vi.fn(),
    getAssets: vi.fn(() => ({})),
    exportImage,
    exportDocument: vi.fn(async () => new Blob(["scene"])),
    importDocument,
    destroy: vi.fn(),
  };

  return {
    engine,
    spies: {
      exportImage,
      clearDocument,
      fitToContent,
      importDocument,
      setActiveTool,
      undo,
      updateElementStyle,
      updateViewport,
    },
  };
}

function renderShell(engine: WhiteboardEngine | null) {
  const actions = {
    onRename: vi.fn(),
    onImported: vi.fn(),
    onSave: vi.fn(),
    onShare: vi.fn(),
    onWorkspace: vi.fn(),
  };
  const view = render(
    <WhiteboardShell engine={engine} sceneName="Test board" {...actions}>
      <div data-testid="canvas">Canvas</div>
    </WhiteboardShell>,
  );
  return { ...view, actions };
}

describe("owned whiteboard shell", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
  });

  it("changes tools through labeled controls and keyboard shortcuts", async () => {
    const { engine, spies } = createTestEngine();
    renderShell(engine);

    const toolbar = screen.getByRole("toolbar", { name: "Drawing tools" });
    const toolButtons = within(toolbar).getAllByRole("button");
    expect(
      toolButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Select",
      "Hand",
      "Rectangle",
      "Diamond",
      "Ellipse",
      "Arrow",
      "Line",
      "Draw",
      "Text",
      "Image",
      "Eraser",
      "Frame",
      "Laser",
    ]);
    expect(toolButtons.filter((button) => button.tabIndex === 0)).toHaveLength(
      1,
    );

    const rectangle = screen.getByRole("button", { name: "Rectangle" });
    rectangle.focus();
    fireEvent.keyDown(rectangle, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Diamond");
    fireEvent.click(rectangle);
    expect(spies.setActiveTool).toHaveBeenLastCalledWith({
      type: "rectangle",
    });
    expect(
      screen
        .getByRole("button", { name: "Rectangle" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.keyDown(window, { key: "8" });
    expect(spies.setActiveTool).toHaveBeenLastCalledWith({ type: "text" });

    fireEvent.keyDown(window, { key: "e" });
    expect(spies.setActiveTool).toHaveBeenLastCalledWith({ type: "eraser" });
    fireEvent.keyDown(window, { key: "e" });
    expect(spies.setActiveTool).toHaveBeenLastCalledWith({ type: "selection" });

    fireEvent.keyDown(window, { key: "?" });
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).not.toBeNull();
    fireEvent.keyDown(window, { key: "2" });
    expect(spies.setActiveTool).toHaveBeenLastCalledWith({ type: "selection" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
      ).toBeNull(),
    );
  });

  it("sends property changes to the engine instead of canvas internals", () => {
    const { engine, spies } = createTestEngine();
    renderShell(engine);

    fireEvent.click(
      screen.getByRole("button", { name: "Stroke color: #1971c2" }),
    );
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      strokeColor: "#1971c2",
    });

    fireEvent.click(screen.getByRole("button", { name: "Solid fill" }));
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      fillStyle: "solid",
    });

    const opacity = document.querySelector<HTMLInputElement>(
      'input[type="range"][aria-label="Opacity"]',
    );
    expect(opacity).not.toBeNull();
    fireEvent.keyDown(opacity!, { key: "ArrowLeft" });
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      opacity: 90,
    });
  });

  it("controls zoom, fit, and canvas history from owned controls and context menu", async () => {
    const { engine, spies } = createTestEngine();
    const { container } = renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(spies.updateViewport).toHaveBeenLastCalledWith({ zoom: 1.1 });

    fireEvent.keyDown(window, { key: "-" });
    expect(spies.updateViewport).toHaveBeenLastCalledWith({ zoom: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Fit to content" }));
    expect(spies.fitToContent).toHaveBeenCalledWith({
      animate: true,
      fitToViewport: true,
    });

    const contextTrigger = container.querySelector(
      '[data-slot="context-menu-trigger"]',
    );
    expect(contextTrigger).not.toBeNull();
    fireEvent.contextMenu(contextTrigger!);
    const undo = await screen.findByRole("menuitem", { name: /Undo/ });
    fireEvent.click(undo);
    expect(spies.undo).toHaveBeenCalledOnce();
  });

  it("opens product dialogs from the main menu and calls engine import/export methods", async () => {
    const { engine, spies } = createTestEngine();
    const { actions } = renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import" }));

    const importDialog = screen.getByRole("dialog", { name: "Import scene" });
    const file = new File(["scene"], "board.excalidraw", {
      type: "application/json",
    });
    fireEvent.change(within(importDialog).getByLabelText("Scene file"), {
      target: { files: [file] },
    });
    fireEvent.click(
      within(importDialog).getByRole("button", { name: "Import" }),
    );
    await waitFor(() =>
      expect(spies.importDocument).toHaveBeenCalledWith(file),
    );
    expect(screen.queryByRole("dialog", { name: "Import scene" })).toBeNull();
    expect(actions.onImported).toHaveBeenCalledWith("Imported board");

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export" }));
    const exportDialog = screen.getByRole("dialog", { name: "Export scene" });
    fireEvent.click(within(exportDialog).getByRole("button", { name: "SVG" }));
    fireEvent.click(
      within(exportDialog).getByRole("button", { name: "Export" }),
    );
    await waitFor(() =>
      expect(spies.exportImage).toHaveBeenCalledWith({ format: "svg" }),
    );
  });

  it("confirms an undoable clear through the engine", async () => {
    const { engine, spies } = createTestEngine();
    renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Clear canvas" }),
    );
    const dialog = screen.getByRole("alertdialog", {
      name: "Clear the canvas?",
    });
    expect(spies.clearDocument).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clear canvas" }),
    );
    expect(spies.clearDocument).toHaveBeenCalledOnce();
  });

  it("keeps product actions and disconnected states explicit", () => {
    const { engine } = createTestEngine();
    const connected = renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Test board" }));
    expect(connected.actions.onRename).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(connected.actions.onShare).toHaveBeenCalledOnce();
    connected.unmount();

    renderShell(null);
    expect(
      screen.getByRole("button", { name: "Share" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Rectangle" })
        .getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Zoom in" }).getAttribute("disabled"),
    ).not.toBeNull();

    fireEvent.keyDown(window, { key: "2" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
