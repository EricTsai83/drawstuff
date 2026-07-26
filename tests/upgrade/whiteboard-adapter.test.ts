import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  WhiteboardAsset,
  WhiteboardDocument,
} from "@/features/whiteboard";
import {
  createExcalidrawAdapterDelegates,
  ExcalidrawEngineAdapter,
  type ExcalidrawAdapterDelegates,
} from "@/features/whiteboard/adapters/excalidraw";

const rectangle = {
  id: "rectangle-1",
  type: "rectangle",
  isDeleted: false,
} as ExcalidrawElement;

const deletedRectangle = {
  id: "deleted-rectangle",
  type: "rectangle",
  isDeleted: true,
} as ExcalidrawElement;

const imageAsset = {
  id: "asset-1",
  dataURL: "data:image/png;base64,AA==",
  mimeType: "image/png",
  created: 1,
  lastRetrieved: 2,
} as WhiteboardAsset;

function createHarness() {
  let elements: readonly ExcalidrawElement[] = [rectangle];
  let appState = {
    name: "Adapter scene",
    theme: "light",
    scrollX: 10,
    scrollY: 20,
    width: 1000,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
    zoom: { value: 1 },
    activeTool: { type: "selection", locked: false, customType: null },
    selectedElementIds: {},
  } as unknown as AppState;
  let files = { [imageAsset.id]: imageAsset } as unknown as BinaryFiles;

  const changeListeners: Array<
    (
      nextElements: readonly ExcalidrawElement[],
      nextState: AppState,
      nextFiles: BinaryFiles,
    ) => void
  > = [];
  const scrollListeners: Array<
    (scrollX: number, scrollY: number, zoom: AppState["zoom"]) => void
  > = [];
  const changeUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  const scrollUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];

  const updateScene = vi.fn(
    (update: {
      elements?: readonly ExcalidrawElement[];
      appState?: Partial<AppState>;
    }) => {
      elements = update.elements ?? elements;
      appState = { ...appState, ...update.appState };
    },
  );
  const addFiles = vi.fn((assets: WhiteboardAsset[]) => {
    files = {
      ...files,
      ...Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    } as unknown as BinaryFiles;
  });
  const setActiveTool = vi.fn((tool: AppState["activeTool"]) => {
    appState = { ...appState, activeTool: tool };
  });
  const scrollToContent = vi.fn();

  const api = {
    updateScene,
    addFiles,
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    getFiles: () => files,
    getName: () => "Resolved adapter name",
    setActiveTool,
    scrollToContent,
    onChange: (
      listener: (
        nextElements: readonly ExcalidrawElement[],
        nextState: AppState,
        nextFiles: BinaryFiles,
      ) => void,
    ) => {
      changeListeners.push(listener);
      const unsubscribe = vi.fn();
      changeUnsubscribes.push(unsubscribe);
      return unsubscribe;
    },
    onScrollChange: (
      listener: (
        scrollX: number,
        scrollY: number,
        zoom: AppState["zoom"],
      ) => void,
    ) => {
      scrollListeners.push(listener);
      const unsubscribe = vi.fn();
      scrollUnsubscribes.push(unsubscribe);
      return unsubscribe;
    },
  } as unknown as ExcalidrawImperativeAPI;

  const imageBlob = new Blob(["image"]);
  const documentBlob = new Blob(["document"]);
  const delegates: ExcalidrawAdapterDelegates = {
    undo: vi.fn(),
    redo: vi.fn(),
    exportImage: vi.fn(async () => imageBlob),
    exportDocument: vi.fn(async () => documentBlob),
  };

  return {
    api,
    delegates,
    updateScene,
    addFiles,
    setActiveTool,
    scrollToContent,
    changeListeners,
    scrollListeners,
    changeUnsubscribes,
    scrollUnsubscribes,
    imageBlob,
    documentBlob,
  };
}

describe("ExcalidrawEngineAdapter contract", () => {
  let harness: ReturnType<typeof createHarness>;
  let engine: ExcalidrawEngineAdapter;

  beforeEach(() => {
    harness = createHarness();
    engine = new ExcalidrawEngineAdapter(harness.api, harness.delegates);
  });

  it("loads and reads the active document without changing its legacy shape", () => {
    const nextDocument: WhiteboardDocument = {
      elements: [{ id: "line-1", type: "line", isDeleted: false }],
      state: {
        name: "Loaded",
        theme: "dark",
        scrollX: 5,
        scrollY: 6,
        zoom: { value: 2 },
      },
      assets: { [imageAsset.id]: imageAsset },
    };

    engine.loadDocument(nextDocument);

    expect(harness.updateScene).toHaveBeenCalledOnce();
    const update = harness.updateScene.mock.calls[0]?.[0];
    expect(update?.elements).toBe(nextDocument.elements);
    expect(update?.appState).toMatchObject(nextDocument.state);
    expect(harness.addFiles).toHaveBeenCalledWith([imageAsset]);
    expect(engine.getDocument()).toMatchObject(nextDocument);
  });

  it("subscribes to document and editor state and tears every listener down", () => {
    const onDocument = vi.fn();
    const onEditorState = vi.fn();
    const unsubscribeDocument = engine.subscribeDocument(onDocument);
    engine.subscribeEditorState(onEditorState);

    harness.changeListeners[0]?.(
      harness.api.getSceneElements(),
      harness.api.getAppState(),
      harness.api.getFiles(),
    );
    harness.changeListeners[1]?.(
      harness.api.getSceneElements(),
      harness.api.getAppState(),
      harness.api.getFiles(),
    );
    harness.scrollListeners[0]?.(10, 20, harness.api.getAppState().zoom);

    expect(onDocument).toHaveBeenCalledWith(engine.getDocument());
    expect(onEditorState).toHaveBeenCalledTimes(2);

    unsubscribeDocument();
    engine.destroy();
    engine.destroy();

    expect(harness.changeUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(harness.changeUnsubscribes[1]).toHaveBeenCalledOnce();
    expect(harness.scrollUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(() => engine.getDocument()).toThrow(
      "Whiteboard engine has been destroyed",
    );
  });

  it("replays a document change that arrives before the product subscribes", () => {
    harness.changeListeners[0]?.(
      harness.api.getSceneElements(),
      harness.api.getAppState(),
      harness.api.getFiles(),
    );
    const onDocument = vi.fn();

    engine.subscribeDocument(onDocument);

    expect(onDocument).toHaveBeenCalledOnce();
    expect(onDocument).toHaveBeenCalledWith(engine.getDocument());
  });

  it("reads and publishes the same including-deleted document shape", () => {
    harness.updateScene({ elements: [rectangle, deletedRectangle] });
    const onDocument = vi.fn();
    engine.subscribeDocument(onDocument);
    harness.changeListeners[0]?.(
      [rectangle, deletedRectangle],
      harness.api.getAppState(),
      harness.api.getFiles(),
    );

    expect(engine.getDocument().elements).toEqual([
      rectangle,
      deletedRectangle,
    ]);
    expect(onDocument).toHaveBeenCalledWith(engine.getDocument());
    expect(engine.getEditorState().name).toBe("Resolved adapter name");
  });

  it("delegates tool selection, viewport changes, history, assets, and exports", async () => {
    engine.setActiveTool({ type: "rectangle", locked: true });
    expect(harness.setActiveTool).toHaveBeenCalledWith({
      type: "rectangle",
      locked: true,
    });
    expect(engine.getActiveTool()).toMatchObject({
      type: "rectangle",
      locked: true,
    });

    engine.updateViewport({ x: 30, zoom: 1.5 });
    expect(engine.getViewport()).toEqual({
      x: 30,
      y: 20,
      zoom: 1.5,
      width: 1000,
      height: 800,
      offsetX: 0,
      offsetY: 0,
    });
    engine.fitToContent({ animate: true, viewportZoomFactor: 0.5 });
    expect(harness.scrollToContent).toHaveBeenCalledWith(undefined, {
      fitToViewport: true,
      animate: true,
      viewportZoomFactor: 0.5,
    });

    engine.undo();
    engine.redo();
    expect(harness.delegates.undo).toHaveBeenCalledOnce();
    expect(harness.delegates.redo).toHaveBeenCalledOnce();

    const secondAsset = { ...imageAsset, id: "asset-2" };
    engine.addAssets([secondAsset]);
    expect(engine.getAssets()).toMatchObject({
      [imageAsset.id]: imageAsset,
      [secondAsset.id]: secondAsset,
    });

    await expect(engine.exportImage({ format: "png" })).resolves.toBe(
      harness.imageBlob,
    );
    await expect(engine.exportDocument()).resolves.toBe(harness.documentBlob);
    expect(harness.delegates.exportImage).toHaveBeenCalledWith(
      engine.getDocument(),
      { format: "png" },
    );
    expect(harness.delegates.exportDocument).toHaveBeenCalledWith(
      engine.getDocument(),
    );
  });

  it("dispatches platform history shortcuts through the Excalidraw container", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const events: KeyboardEvent[] = [];
    const onKeyDown = (event: KeyboardEvent) => events.push(event);
    document.addEventListener("keydown", onKeyDown);
    const delegates = createExcalidrawAdapterDelegates(() => container);

    delegates.undo();
    delegates.redo();

    const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      key: "z",
      code: "KeyZ",
      bubbles: true,
      ctrlKey: !isApplePlatform,
      metaKey: isApplePlatform,
      shiftKey: false,
    });
    expect(events[1]).toMatchObject({
      key: "z",
      code: "KeyZ",
      ctrlKey: !isApplePlatform,
      metaKey: isApplePlatform,
      shiftKey: true,
    });

    document.removeEventListener("keydown", onKeyDown);
    container.remove();
  });
});
