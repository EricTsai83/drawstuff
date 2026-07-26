import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  WhiteboardAsset,
  WhiteboardDocument,
  WhiteboardEditorState,
  WhiteboardEditorStateUpdate,
  WhiteboardEngine,
  WhiteboardImageExportOptions,
  WhiteboardTool,
  WhiteboardUnsubscribe,
  WhiteboardViewport,
} from "@/features/whiteboard";
import {
  toExcalidrawAppState,
  toExcalidrawAssets,
  toExcalidrawElements,
  toExcalidrawTool,
  toWhiteboardDocument,
} from "./conversions";
import { exportExcalidrawDocument, exportExcalidrawImage } from "./exporters";

export interface ExcalidrawAdapterDelegates {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly exportImage: (
    document: WhiteboardDocument,
    options: WhiteboardImageExportOptions,
  ) => Promise<Blob>;
  readonly exportDocument: (document: WhiteboardDocument) => Promise<Blob>;
}

const DEFAULT_VIEWPORT: WhiteboardViewport = {
  x: 0,
  y: 0,
  zoom: 1,
  width: 0,
  height: 0,
  offsetX: 0,
  offsetY: 0,
};

export class ExcalidrawEngineAdapter implements WhiteboardEngine {
  private readonly subscriptions = new Set<WhiteboardUnsubscribe>();
  private readonly documentListeners = new Set<
    (document: WhiteboardDocument) => void
  >();
  private latestDocument: WhiteboardDocument | null = null;
  private destroyed = false;

  public constructor(
    private readonly api: ExcalidrawImperativeAPI,
    private readonly delegates: ExcalidrawAdapterDelegates,
  ) {
    this.trackSubscription(
      this.api.onChange((elements, appState, files) => {
        const document = toWhiteboardDocument(elements, appState, files);
        this.latestDocument = document;
        for (const listener of this.documentListeners) {
          listener(document);
        }
      }),
    );
  }

  public loadDocument(document: WhiteboardDocument): void {
    this.assertActive();
    this.api.updateScene({
      elements: toExcalidrawElements(document.elements),
      appState: {
        ...this.api.getAppState(),
        ...toExcalidrawAppState(document.state),
      },
    });
    const assets = Object.values(document.assets);
    if (assets.length > 0) {
      this.api.addFiles(toExcalidrawAssets(assets));
    }
  }

  public getDocument(): WhiteboardDocument {
    this.assertActive();
    return toWhiteboardDocument(
      this.api.getSceneElementsIncludingDeleted(),
      this.api.getAppState(),
      this.api.getFiles(),
    );
  }

  public subscribeDocument(
    listener: (document: WhiteboardDocument) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.documentListeners.add(listener);
    const unsubscribe = this.trackSubscription(() =>
      this.documentListeners.delete(listener),
    );
    if (this.latestDocument) {
      listener(this.latestDocument);
    }
    return unsubscribe;
  }

  public getEditorState(): WhiteboardEditorState {
    this.assertActive();
    const appState = this.api.getAppState();
    return {
      activeTool: this.getActiveToolFromState(appState),
      viewport: this.getViewportFromState(appState),
      name: this.api.getName() ?? appState.name ?? "",
      theme: appState.theme === "dark" ? "dark" : "light",
      selectedElementIds: Object.keys(appState.selectedElementIds ?? {}).filter(
        (id) => Boolean(appState.selectedElementIds[id]),
      ),
    };
  }

  public subscribeEditorState(
    listener: (state: WhiteboardEditorState) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    const unsubscribeChange = this.api.onChange(() => {
      listener(this.getEditorState());
    });
    const unsubscribeScroll = this.api.onScrollChange(() => {
      listener(this.getEditorState());
    });
    return this.trackSubscription(() => {
      unsubscribeChange();
      unsubscribeScroll();
    });
  }

  public updateEditorState(update: WhiteboardEditorStateUpdate): void {
    this.assertActive();
    const current = this.api.getAppState();
    this.api.updateScene({
      appState: {
        ...current,
        ...update,
      } as AppState,
    });
  }

  public getActiveTool(): WhiteboardTool {
    this.assertActive();
    return this.getActiveToolFromState(this.api.getAppState());
  }

  public setActiveTool(tool: WhiteboardTool): void {
    this.assertActive();
    this.api.setActiveTool(toExcalidrawTool(tool));
  }

  public getViewport(): WhiteboardViewport {
    this.assertActive();
    return this.getViewportFromState(this.api.getAppState());
  }

  public updateViewport(
    update: Partial<Pick<WhiteboardViewport, "x" | "y" | "zoom">>,
  ): void {
    this.assertActive();
    const currentState = this.api.getAppState();
    const currentViewport = this.getViewportFromState(currentState);
    const viewport = { ...currentViewport, ...update };
    this.api.updateScene({
      appState: {
        ...currentState,
        scrollX: viewport.x,
        scrollY: viewport.y,
        zoom: {
          ...currentState.zoom,
          value: viewport.zoom as AppState["zoom"]["value"],
        },
      },
    });
  }

  public fitToContent(options?: {
    readonly animate?: boolean;
    readonly fitToViewport?: boolean;
    readonly viewportZoomFactor?: number;
  }): void {
    this.assertActive();
    this.api.scrollToContent(undefined, {
      fitToViewport: options?.fitToViewport ?? true,
      animate: options?.animate ?? false,
      viewportZoomFactor: options?.viewportZoomFactor,
    });
  }

  public undo(): void {
    this.assertActive();
    this.delegates.undo();
  }

  public redo(): void {
    this.assertActive();
    this.delegates.redo();
  }

  public addAssets(assets: readonly WhiteboardAsset[]): void {
    this.assertActive();
    if (assets.length > 0) {
      this.api.addFiles(toExcalidrawAssets(assets));
    }
  }

  public getAssets(): Readonly<Record<string, WhiteboardAsset>> {
    this.assertActive();
    return toWhiteboardDocument([], {}, this.api.getFiles()).assets;
  }

  public async exportImage(
    options: WhiteboardImageExportOptions,
  ): Promise<Blob> {
    this.assertActive();
    return await this.delegates.exportImage(this.getDocument(), options);
  }

  public async exportDocument(): Promise<Blob> {
    this.assertActive();
    return await this.delegates.exportDocument(this.getDocument());
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const unsubscribe of [...this.subscriptions]) {
      unsubscribe();
    }
    this.subscriptions.clear();
    this.documentListeners.clear();
    this.latestDocument = null;
  }

  private getActiveToolFromState(appState: AppState): WhiteboardTool {
    const tool = appState.activeTool;
    return {
      type: tool.type,
      locked: tool.locked,
      customType: tool.customType,
    };
  }

  private getViewportFromState(appState: AppState): WhiteboardViewport {
    return {
      x: Number.isFinite(appState.scrollX)
        ? appState.scrollX
        : DEFAULT_VIEWPORT.x,
      y: Number.isFinite(appState.scrollY)
        ? appState.scrollY
        : DEFAULT_VIEWPORT.y,
      zoom: Number.isFinite(appState.zoom?.value)
        ? appState.zoom.value
        : DEFAULT_VIEWPORT.zoom,
      width: Number.isFinite(appState.width)
        ? appState.width
        : DEFAULT_VIEWPORT.width,
      height: Number.isFinite(appState.height)
        ? appState.height
        : DEFAULT_VIEWPORT.height,
      offsetX: Number.isFinite(appState.offsetLeft)
        ? appState.offsetLeft
        : DEFAULT_VIEWPORT.offsetX,
      offsetY: Number.isFinite(appState.offsetTop)
        ? appState.offsetTop
        : DEFAULT_VIEWPORT.offsetY,
    };
  }

  private trackSubscription(
    unsubscribe: WhiteboardUnsubscribe,
  ): WhiteboardUnsubscribe {
    let active = true;
    const trackedUnsubscribe = () => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(trackedUnsubscribe);
      unsubscribe();
    };
    this.subscriptions.add(trackedUnsubscribe);
    return trackedUnsubscribe;
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error("Whiteboard engine has been destroyed");
    }
  }
}

function dispatchHistoryShortcut(
  getContainer: () => HTMLElement | null,
  command: "undo" | "redo",
): void {
  const container = getContainer();
  if (!container) return;
  const isApplePlatform =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  container.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      bubbles: true,
      cancelable: true,
      ctrlKey: !isApplePlatform,
      metaKey: isApplePlatform,
      shiftKey: command === "redo",
    }),
  );
}

export function createExcalidrawAdapterDelegates(
  getContainer: () => HTMLElement | null,
): ExcalidrawAdapterDelegates {
  return {
    undo: () => dispatchHistoryShortcut(getContainer, "undo"),
    redo: () => dispatchHistoryShortcut(getContainer, "redo"),
    exportImage: exportExcalidrawImage,
    exportDocument: exportExcalidrawDocument,
  };
}
