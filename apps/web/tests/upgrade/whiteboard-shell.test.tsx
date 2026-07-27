import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OwnedWhiteboardDocument,
  OwnedWhiteboardEditorState,
  OwnedWhiteboardEditorStateUpdate,
  WhiteboardElementStyleUpdate,
  WhiteboardEngine,
  WhiteboardTool,
  WhiteboardViewport,
} from "@drawstuff/whiteboard";
import { WhiteboardShell } from "@/features/whiteboard/ui";
import { SCENE_FILE_IMPORT_MAX_BYTES } from "@/config/app-constants";

const DOCUMENT: OwnedWhiteboardDocument = {
  elements: [
    {
      id: "shape-1",
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
    },
  ],
  state: { name: "Test board", theme: "light" },
  assets: {},
};

const INITIAL_STATE: OwnedWhiteboardEditorState = {
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
  const editorListeners = new Set<
    (value: OwnedWhiteboardEditorState) => void
  >();
  const documentListeners = new Set<(value: OwnedWhiteboardDocument) => void>();

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
  const reorderSelection = vi.fn();
  const undo = vi.fn();
  const clearDocument = vi.fn();
  const exportImage = vi.fn(async () => new Blob(["image"]));
  const insertImage = vi.fn(async () => undefined);
  const importDocument = vi.fn(async () => ({ name: "Imported board" }));

  const engine: WhiteboardEngine = {
    loadDocument: vi.fn((nextDocument: OwnedWhiteboardDocument) => {
      document = nextDocument;
      for (const listener of documentListeners) listener(document);
    }),
    getDocument: vi.fn(() => document),
    subscribeDocument: vi.fn(
      (listener: (value: OwnedWhiteboardDocument) => void) => {
        documentListeners.add(listener);
        return () => documentListeners.delete(listener);
      },
    ),
    getEditorState: vi.fn(() => state),
    subscribeEditorState: vi.fn(
      (listener: (value: OwnedWhiteboardEditorState) => void) => {
        editorListeners.add(listener);
        return () => editorListeners.delete(listener);
      },
    ),
    updateEditorState: vi.fn((update: OwnedWhiteboardEditorStateUpdate) => {
      state = { ...state, ...update };
      publishEditorState();
    }),
    getActiveTool: vi.fn(() => state.activeTool),
    setActiveTool,
    updateElementStyle,
    getViewport: vi.fn(() => state.viewport),
    updateViewport,
    fitToContent,
    reorderSelection,
    undo,
    redo: vi.fn(),
    clearDocument,
    addAssets: vi.fn(),
    getAssets: vi.fn(() => ({})),
    insertImage,
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
      insertImage,
      reorderSelection,
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
      "Keep selected tool active after drawing",
      "Hand",
      "Selection",
      "Rectangle",
      "Diamond",
      "Ellipse",
      "Arrow",
      "Line",
      "Draw",
      "Text",
      "Insert image",
      "Eraser",
      "More tools",
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

    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Frame/ }));
    expect(spies.setActiveTool).toHaveBeenLastCalledWith({ type: "frame" });

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

  it("opens the image picker and forwards the selected file to the engine", async () => {
    const { engine, spies } = createTestEngine();
    renderShell(engine);
    const image = new File([new Uint8Array([1, 2, 3])], "asset.png", {
      type: "image/png",
    });

    fireEvent.click(screen.getByRole("button", { name: "Insert image" }));
    fireEvent.change(screen.getByLabelText("Import image"), {
      target: { files: [image] },
    });

    await waitFor(() => expect(spies.insertImage).toHaveBeenCalledWith(image));
    expect(spies.setActiveTool).not.toHaveBeenCalledWith({ type: "image" });
  });

  it("sends property changes to the engine instead of canvas internals", () => {
    const { engine, spies } = createTestEngine();
    renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Stroke: #1971c2" }));
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      strokeColor: "#1971c2",
    });

    fireEvent.click(screen.getByRole("button", { name: "Solid fill" }));
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      fillStyle: "solid",
    });

    fireEvent.click(screen.getByRole("button", { name: "Cartoonist" }));
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      roughness: 2,
    });

    fireEvent.click(screen.getByRole("button", { name: "Sharp edges" }));
    expect(spies.updateElementStyle).toHaveBeenLastCalledWith({
      roundness: "sharp",
    });

    fireEvent.click(screen.getByRole("button", { name: "Bring to front" }));
    expect(spies.reorderSelection).toHaveBeenLastCalledWith("front");

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

    const contextTrigger = container.querySelector(
      '[data-slot="context-menu-trigger"]',
    );
    expect(contextTrigger).not.toBeNull();
    fireEvent.contextMenu(contextTrigger!);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Fit to content" }),
    );
    expect(spies.fitToContent).toHaveBeenCalledWith({
      animate: true,
      fitToViewport: true,
    });

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
    const file = new File(["scene"], "board.drawstuff", {
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
      expect(spies.exportImage).toHaveBeenCalledWith({
        format: "svg",
        scale: 1,
        background: true,
        selectionOnly: false,
      }),
    );
  });

  it("rejects an oversized document before reading it", async () => {
    const { engine, spies } = createTestEngine();
    renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import" }));
    const importDialog = screen.getByRole("dialog", { name: "Import scene" });
    const file = new File(
      [new Uint8Array(SCENE_FILE_IMPORT_MAX_BYTES + 1)],
      "oversized.drawstuff",
      { type: "application/json" },
    );
    fireEvent.change(within(importDialog).getByLabelText("Scene file"), {
      target: { files: [file] },
    });
    fireEvent.click(
      within(importDialog).getByRole("button", { name: "Import" }),
    );

    expect(spies.importDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Import scene" })).not.toBeNull();
  });

  it("disables selection-only export when the scene has no selection", async () => {
    const { engine } = createTestEngine({
      ...INITIAL_STATE,
      selectedElementIds: [],
    });
    renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export" }));

    expect(
      within(screen.getByRole("dialog", { name: "Export scene" }))
        .getByRole("button", { name: "Selection only" })
        .hasAttribute("disabled"),
    ).toBe(true);
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

  it("keeps product actions and disconnected states explicit", async () => {
    const { engine } = createTestEngine();
    const connected = renderShell(engine);

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
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
