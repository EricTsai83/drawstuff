import type {
  WhiteboardAsset,
  WhiteboardDocument,
  WhiteboardEditorState,
  WhiteboardEditorStateUpdate,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardElementStyleUpdate,
  WhiteboardEngine,
  WhiteboardImageExportOptions,
  WhiteboardImportResult,
  WhiteboardTool,
  WhiteboardUnsubscribe,
  WhiteboardViewport,
} from "@/features/whiteboard/contracts";
import {
  createWhiteboardDocumentV1,
  filterReferencedWhiteboardAssets,
  parsePersistedWhiteboardPayload,
  toRuntimeWhiteboardDocument,
} from "@/features/whiteboard/document-format";
import { createWhiteboardImageElement, importWhiteboardImage } from "./assets";
import {
  exportOwnedWhiteboardDocument,
  exportOwnedWhiteboardImage,
} from "./export";
import {
  getDocumentBounds,
  isElementSelectable,
  zoomViewportAt,
  type WhiteboardPoint,
} from "./geometry";
import {
  createOwnedClipboardPayload,
  remapOwnedClipboardPayload,
  type OwnedClipboardPayloadV1,
} from "./clipboard";

export const OWNED_MIN_ZOOM = 0.05;
export const OWNED_MAX_ZOOM = 16;
export const OWNED_HISTORY_LIMIT = 100;

export type OwnedDocumentCommandKind =
  | "clear"
  | "create"
  | "cut"
  | "delete"
  | "duplicate"
  | "metadata"
  | "move"
  | "paste"
  | "resize"
  | "rotate"
  | "style";

interface OwnedDocumentCommand {
  readonly kind: OwnedDocumentCommandKind;
  readonly before: WhiteboardDocument;
  readonly after: WhiteboardDocument;
}

interface ActiveElementGesture {
  readonly kind: "move" | "resize" | "rotate";
  readonly before: WhiteboardDocument;
  readonly elementIds: ReadonlySet<string>;
}

const DEFAULT_STYLE: WhiteboardElementStyle = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  opacity: 100,
  roughness: 1,
};

const DEFAULT_VIEWPORT: WhiteboardViewport = {
  x: 0,
  y: 0,
  zoom: 1,
  width: 0,
  height: 0,
  offsetX: 0,
  offsetY: 0,
};

const EMPTY_DOCUMENT: WhiteboardDocument = {
  elements: [],
  assets: {},
  state: {
    name: "",
    theme: "light",
    viewBackgroundColor: "#ffffff",
    gridSize: null,
  },
};

export type OwnedWhiteboardRenderChange = "overlay" | "scene";
export type OwnedWhiteboardRenderListener = (
  change: OwnedWhiteboardRenderChange,
) => void;

export class OwnedWhiteboardStore implements WhiteboardEngine {
  private document: WhiteboardDocument = EMPTY_DOCUMENT;
  private documentSnapshot: WhiteboardDocument = EMPTY_DOCUMENT;
  private documentWithViewportSnapshot: WhiteboardDocument = EMPTY_DOCUMENT;
  private viewport: WhiteboardViewport = DEFAULT_VIEWPORT;
  private activeTool: WhiteboardTool = { type: "selection" };
  private selectedElementIds: readonly string[] = [];
  private elementStyle: WhiteboardElementStyle = DEFAULT_STYLE;
  private readonly documentListeners = new Set<
    (document: WhiteboardDocument) => void
  >();
  private readonly editorListeners = new Set<
    (state: WhiteboardEditorState) => void
  >();
  private readonly renderListeners = new Set<OwnedWhiteboardRenderListener>();
  private readonly destroyListeners = new Set<() => void>();
  private readonly undoStack: OwnedDocumentCommand[] = [];
  private readonly redoStack: OwnedDocumentCommand[] = [];
  private activeElementGesture: ActiveElementGesture | null = null;
  private destroyed = false;

  public loadDocument(document: WhiteboardDocument): void {
    this.assertActive();
    const nextZoom = clampZoom(document.state.zoom?.value, this.viewport.zoom);
    this.document = document;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.activeElementGesture = null;
    this.refreshDocumentSnapshot();
    this.viewport = {
      ...this.viewport,
      x: finiteNumber(document.state.scrollX, 0),
      y: finiteNumber(document.state.scrollY, 0),
      zoom: nextZoom,
    };
    this.refreshViewportSnapshot();
    const selectableIds = new Set(
      this.documentSnapshot.elements
        .filter(isElementSelectable)
        .map((element) => element.id),
    );
    this.selectedElementIds = this.selectedElementIds.filter((id) =>
      selectableIds.has(id),
    );
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public getDocument(): WhiteboardDocument {
    this.assertActive();
    return this.getDocumentWithViewport();
  }

  public subscribeDocument(
    listener: (document: WhiteboardDocument) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.documentListeners.add(listener);
    return () => this.documentListeners.delete(listener);
  }

  public getEditorState(): WhiteboardEditorState {
    this.assertActive();
    const selectedElement = this.document.elements.find((element) =>
      this.selectedElementIds.includes(element.id),
    );
    return {
      activeTool: this.activeTool,
      viewport: this.viewport,
      name:
        typeof this.document.state.name === "string"
          ? this.document.state.name
          : "",
      theme: this.document.state.theme === "dark" ? "dark" : "light",
      selectedElementIds: this.selectedElementIds,
      elementStyle: selectedElement
        ? styleFromElement(selectedElement, this.elementStyle)
        : this.elementStyle,
    };
  }

  public subscribeEditorState(
    listener: (state: WhiteboardEditorState) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.editorListeners.add(listener);
    return () => this.editorListeners.delete(listener);
  }

  public updateEditorState(update: WhiteboardEditorStateUpdate): void {
    this.assertActive();
    if (update.name !== undefined) this.finalizeActiveElementGesture();
    const before = this.document;
    const nextState = {
      ...this.document.state,
      ...(update.name === undefined ? {} : { name: update.name }),
      ...(update.theme === undefined ? {} : { theme: update.theme }),
      ...(update.openDialog === undefined
        ? {}
        : { openDialog: update.openDialog }),
      ...(update.openMenu === undefined ? {} : { openMenu: update.openMenu }),
    };
    if (shallowRecordEqual(this.document.state, nextState)) return;
    this.document = { ...this.document, state: nextState };
    const nonHistoricalState = {
      ...(update.theme === undefined ? {} : { theme: update.theme }),
      ...(update.openDialog === undefined
        ? {}
        : { openDialog: update.openDialog }),
      ...(update.openMenu === undefined ? {} : { openMenu: update.openMenu }),
    };
    if (Object.keys(nonHistoricalState).length > 0) {
      this.rebaseHistoryDocuments((document) => ({
        ...document,
        state: { ...document.state, ...nonHistoricalState },
      }));
    }
    this.refreshDocumentSnapshot();
    if (update.name !== undefined) {
      this.recordDocumentMutation("metadata", {
        ...before,
        state: { ...before.state, ...nonHistoricalState },
      });
    }
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public getActiveTool(): WhiteboardTool {
    this.assertActive();
    return this.activeTool;
  }

  public setActiveTool(tool: WhiteboardTool): void {
    this.assertActive();
    this.activeTool = tool;
    this.emitEditor();
  }

  public updateElementStyle(update: WhiteboardElementStyleUpdate): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    this.elementStyle = { ...this.elementStyle, ...update };
    if (this.selectedElementIds.length > 0) {
      const selectedIds = new Set(this.selectedElementIds);
      const changesDocument = this.document.elements.some(
        (element) =>
          selectedIds.has(element.id) && elementStyleDiffers(element, update),
      );
      if (!changesDocument) {
        this.emitEditor();
        return;
      }
      const before = this.document;
      this.document = {
        ...this.document,
        elements: this.document.elements.map((element) =>
          selectedIds.has(element.id)
            ? {
                ...element,
                ...update,
              }
            : element,
        ),
      };
      this.refreshDocumentSnapshot();
      this.recordDocumentMutation("style", before);
      this.emitDocument();
    }
    this.emitEditor();
    if (this.selectedElementIds.length > 0) this.emitRender("scene");
  }

  public getViewport(): WhiteboardViewport {
    this.assertActive();
    return this.viewport;
  }

  public updateViewport(
    update: Partial<Pick<WhiteboardViewport, "x" | "y" | "zoom">>,
  ): void {
    this.assertActive();
    const zoom = clampZoom(update.zoom, this.viewport.zoom);
    const zoomChanged =
      update.zoom !== undefined && zoom !== this.viewport.zoom;
    const centered = zoomChanged
      ? zoomViewportAt(this.viewport, zoom, {
          x: this.viewport.offsetX + this.viewport.width / 2,
          y: this.viewport.offsetY + this.viewport.height / 2,
        })
      : this.viewport;
    this.viewport = {
      ...this.viewport,
      x: finiteNumber(update.x, centered.x),
      y: finiteNumber(update.y, centered.y),
      zoom,
    };
    this.refreshViewportSnapshot();
    this.emitEditor();
    this.emitRender("scene");
  }

  public fitToContent(options?: {
    readonly animate?: boolean;
    readonly fitToViewport?: boolean;
    readonly viewportZoomFactor?: number;
  }): void {
    this.assertActive();
    const bounds = getDocumentBounds(this.document.elements);
    if (!bounds || this.viewport.width <= 0 || this.viewport.height <= 0)
      return;
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    const factor = clampFactor(options?.viewportZoomFactor);
    const zoom =
      options?.fitToViewport === false
        ? this.viewport.zoom
        : clampZoom(
            Math.min(
              (this.viewport.width * factor) / contentWidth,
              (this.viewport.height * factor) / contentHeight,
            ),
            this.viewport.zoom,
          );
    this.viewport = {
      ...this.viewport,
      zoom,
      x: (this.viewport.width / zoom - contentWidth) / 2 - bounds.minX,
      y: (this.viewport.height / zoom - contentHeight) / 2 - bounds.minY,
    };
    this.refreshViewportSnapshot();
    this.emitEditor();
    this.emitRender("scene");
  }

  public undo(): void {
    this.assertActive();
    this.cancelElementGesture();
    const command = this.undoStack.pop();
    if (!command) return;
    this.redoStack.push(command);
    this.restoreHistoryDocument(command.before);
  }

  public redo(): void {
    this.assertActive();
    this.cancelElementGesture();
    const command = this.redoStack.pop();
    if (!command) return;
    this.undoStack.push(command);
    this.restoreHistoryDocument(command.after);
  }

  public clearDocument(): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.document.elements.length === 0) return;
    const before = this.document;
    this.document = { ...this.document, elements: [] };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("clear", before);
    this.selectedElementIds = [];
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public appendElement(element: WhiteboardElement): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    const before = this.document;
    this.document = {
      ...this.document,
      elements: [...this.document.elements, element],
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("create", before);
    this.selectedElementIds = [element.id];
    if (!this.activeTool.locked) {
      this.activeTool = { type: "selection" };
    }
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public addAssets(assets: readonly WhiteboardAsset[]): void {
    this.assertActive();
    if (assets.length === 0) return;
    this.document = {
      ...this.document,
      assets: {
        ...this.document.assets,
        ...Object.fromEntries(assets.map((asset) => [asset.id, asset])),
      },
    };
    this.rebaseHistoryDocuments((document) => ({
      ...document,
      assets: {
        ...document.assets,
        ...Object.fromEntries(assets.map((asset) => [asset.id, asset])),
      },
    }));
    this.refreshDocumentSnapshot();
    this.emitDocument();
    this.emitRender("scene");
  }

  public getAssets(): Readonly<Record<string, WhiteboardAsset>> {
    this.assertActive();
    return this.documentSnapshot.assets;
  }

  public async insertImage(blob: Blob): Promise<void> {
    this.assertActive();
    const imported = await importWhiteboardImage(blob, this.document.assets);
    this.assertActive();
    this.finalizeActiveElementGesture();
    const element = createWhiteboardImageElement(imported, this.viewport);
    const before = this.document;
    this.document = {
      ...this.document,
      elements: [...this.document.elements, element],
      assets: {
        ...this.document.assets,
        [imported.asset.id]: imported.asset,
      },
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("create", before);
    this.selectedElementIds = [element.id];
    this.activeTool = { type: "selection" };
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public async exportImage(
    options: WhiteboardImageExportOptions,
  ): Promise<Blob> {
    this.assertActive();
    return await exportOwnedWhiteboardImage(
      this.documentSnapshot,
      options,
      this.selectedElementIds,
    );
  }

  public async exportDocument(): Promise<Blob> {
    this.assertActive();
    return exportOwnedWhiteboardDocument(this.getDocumentWithViewport());
  }

  public async importDocument(blob: Blob): Promise<WhiteboardImportResult> {
    this.assertActive();
    const parsed = parsePersistedWhiteboardPayload(await blob.text());
    const document =
      parsed.format === "whiteboard-v1"
        ? toRuntimeWhiteboardDocument(parsed.document)
        : parsed.document;
    this.loadDocument(document);
    return {
      name:
        typeof document.state.name === "string" ? document.state.name : null,
    };
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of [...this.destroyListeners]) listener();
    this.destroyListeners.clear();
    this.documentListeners.clear();
    this.editorListeners.clear();
    this.renderListeners.clear();
    this.document = EMPTY_DOCUMENT;
    this.documentSnapshot = EMPTY_DOCUMENT;
    this.documentWithViewportSnapshot = EMPTY_DOCUMENT;
    this.selectedElementIds = [];
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.activeElementGesture = null;
  }

  public subscribeRenderState(
    listener: OwnedWhiteboardRenderListener,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.renderListeners.add(listener);
    return () => this.renderListeners.delete(listener);
  }

  public subscribeDestroy(listener: () => void): WhiteboardUnsubscribe {
    this.assertActive();
    this.destroyListeners.add(listener);
    return () => this.destroyListeners.delete(listener);
  }

  public setSelection(ids: readonly string[]): void {
    this.assertActive();
    const requestedIds = new Set(ids);
    const nextIds = this.document.elements
      .filter(
        (element) =>
          requestedIds.has(element.id) && isElementSelectable(element),
      )
      .map((element) => element.id);
    if (
      nextIds.length === this.selectedElementIds.length &&
      nextIds.every((id, index) => id === this.selectedElementIds[index])
    ) {
      return;
    }
    this.selectedElementIds = nextIds;
    this.emitEditor();
    this.emitRender("overlay");
  }

  public selectAll(): void {
    this.assertActive();
    this.setSelection(
      this.document.elements
        .filter(isElementSelectable)
        .map((element) => element.id),
    );
  }

  public getSelectedElements(): readonly WhiteboardElement[] {
    this.assertActive();
    const selectedIds = new Set(this.selectedElementIds);
    return this.documentSnapshot.elements.filter((element) =>
      selectedIds.has(element.id),
    );
  }

  public createClipboardPayload(): OwnedClipboardPayloadV1 | null {
    this.assertActive();
    const elements = this.getSelectedElements();
    return elements.length > 0
      ? createOwnedClipboardPayload(elements, this.documentSnapshot.assets)
      : null;
  }

  public deleteSelection(kind: "cut" | "delete" = "delete"): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.selectedElementIds.length === 0) return;
    const selectedIds = new Set(this.selectedElementIds);
    const before = this.document;
    this.document = {
      ...this.document,
      elements: this.document.elements.filter(
        (element) => !selectedIds.has(element.id),
      ),
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation(kind, before);
    this.selectedElementIds = [];
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public duplicateSelection(createId: () => string, offset = 20): void {
    const payload = this.createClipboardPayload();
    if (!payload) return;
    this.insertClipboardPayload(payload, createId, offset, "duplicate");
  }

  public pasteClipboardPayload(
    payload: OwnedClipboardPayloadV1,
    createId: () => string,
    offset: number,
  ): void {
    this.assertActive();
    this.insertClipboardPayload(payload, createId, offset, "paste");
  }

  public beginElementGesture(kind: "move" | "resize" | "rotate"): void {
    this.assertActive();
    if (this.activeElementGesture || this.selectedElementIds.length === 0) {
      return;
    }
    this.activeElementGesture = {
      kind,
      before: this.document,
      elementIds: new Set(this.selectedElementIds),
    };
  }

  public updateElementGesture(elements: readonly WhiteboardElement[]): void {
    this.assertActive();
    const gesture = this.activeElementGesture;
    if (!gesture) return;
    const replacements = new Map(
      elements
        .filter((element) => gesture.elementIds.has(element.id))
        .map((element) => [element.id, element]),
    );
    if (replacements.size === 0) return;
    this.document = {
      ...this.document,
      elements: this.document.elements.map(
        (element) => replacements.get(element.id) ?? element,
      ),
    };
    this.documentSnapshot = {
      ...this.documentSnapshot,
      elements: this.documentSnapshot.elements.map(
        (element) => replacements.get(element.id) ?? element,
      ),
    };
    this.emitRender("scene");
  }

  public commitElementGesture(): void {
    this.assertActive();
    const gesture = this.activeElementGesture;
    if (!gesture) return;
    this.activeElementGesture = null;
    if (this.document === gesture.before) return;
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation(gesture.kind, gesture.before);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public cancelElementGesture(): void {
    this.assertActive();
    const gesture = this.activeElementGesture;
    if (!gesture) return;
    this.activeElementGesture = null;
    if (this.document === gesture.before) return;
    this.document = gesture.before;
    this.refreshDocumentSnapshot();
    this.emitEditor();
    this.emitRender("scene");
  }

  public getHistoryDiagnostics(): {
    readonly undoEntries: number;
    readonly redoEntries: number;
    readonly limit: number;
    readonly undoKinds: readonly OwnedDocumentCommandKind[];
  } {
    this.assertActive();
    return {
      undoEntries: this.undoStack.length,
      redoEntries: this.redoStack.length,
      limit: OWNED_HISTORY_LIMIT,
      undoKinds: this.undoStack.map((command) => command.kind),
    };
  }

  public panBy(deltaX: number, deltaY: number, transient = false): void {
    this.assertActive();
    this.viewport = {
      ...this.viewport,
      x: this.viewport.x + finiteNumber(deltaX, 0) / this.viewport.zoom,
      y: this.viewport.y + finiteNumber(deltaY, 0) / this.viewport.zoom,
    };
    this.refreshViewportSnapshot();
    if (!transient) this.emitEditor();
    this.emitRender("scene");
  }

  public zoomAt(
    anchor: WhiteboardPoint,
    zoom: number,
    transient = false,
  ): void {
    this.assertActive();
    this.viewport = {
      ...this.viewport,
      ...zoomViewportAt(
        this.viewport,
        clampZoom(zoom, this.viewport.zoom),
        anchor,
      ),
    };
    this.refreshViewportSnapshot();
    if (!transient) this.emitEditor();
    this.emitRender("scene");
  }

  public commitTransientViewport(): void {
    this.assertActive();
    this.emitEditor();
  }

  public resizeViewport(
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
  ): void {
    this.assertActive();
    const nextViewport = {
      ...this.viewport,
      width: Math.max(0, finiteNumber(width, 0)),
      height: Math.max(0, finiteNumber(height, 0)),
      offsetX: finiteNumber(offsetX, 0),
      offsetY: finiteNumber(offsetY, 0),
    };
    if (
      nextViewport.width === this.viewport.width &&
      nextViewport.height === this.viewport.height &&
      nextViewport.offsetX === this.viewport.offsetX &&
      nextViewport.offsetY === this.viewport.offsetY
    ) {
      return;
    }
    this.viewport = nextViewport;
    this.emitEditor();
    this.emitRender("scene");
  }

  public syncViewportOffset(offsetX: number, offsetY: number): void {
    this.assertActive();
    this.viewport = {
      ...this.viewport,
      offsetX: finiteNumber(offsetX, this.viewport.offsetX),
      offsetY: finiteNumber(offsetY, this.viewport.offsetY),
    };
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  private emitDocument(): void {
    const document = this.getDocumentWithViewport();
    for (const listener of this.documentListeners) listener(document);
  }

  private emitEditor(): void {
    const state = this.getEditorState();
    for (const listener of this.editorListeners) listener(state);
  }

  private emitRender(change: OwnedWhiteboardRenderChange): void {
    for (const listener of this.renderListeners) listener(change);
  }

  private refreshDocumentSnapshot(): void {
    this.documentSnapshot = createSerializableSnapshot(this.document);
    this.refreshViewportSnapshot();
  }

  private getDocumentWithViewport(): WhiteboardDocument {
    return this.documentWithViewportSnapshot;
  }

  private refreshViewportSnapshot(): void {
    this.documentWithViewportSnapshot = {
      ...this.documentSnapshot,
      state: {
        ...this.documentSnapshot.state,
        scrollX: this.viewport.x,
        scrollY: this.viewport.y,
        zoom: { value: this.viewport.zoom },
      },
    };
  }

  private recordDocumentMutation(
    kind: OwnedDocumentCommandKind,
    before: WhiteboardDocument,
  ): void {
    if (before === this.document) return;
    this.undoStack.push({ kind, before, after: this.document });
    if (this.undoStack.length > OWNED_HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private finalizeActiveElementGesture(): void {
    if (this.activeElementGesture) this.commitElementGesture();
  }

  private rebaseHistoryDocuments(
    transform: (document: WhiteboardDocument) => WhiteboardDocument,
  ): void {
    for (const stack of [this.undoStack, this.redoStack]) {
      stack.forEach((command, index) => {
        stack[index] = {
          ...command,
          before: transform(command.before),
          after: transform(command.after),
        };
      });
    }
    if (this.activeElementGesture) {
      this.activeElementGesture = {
        ...this.activeElementGesture,
        before: transform(this.activeElementGesture.before),
      };
    }
  }

  private insertClipboardPayload(
    payload: OwnedClipboardPayloadV1,
    createId: () => string,
    offset: number,
    kind: "duplicate" | "paste",
  ): void {
    this.finalizeActiveElementGesture();
    const remapped = remapOwnedClipboardPayload(
      payload,
      new Set(this.document.elements.map((element) => element.id)),
      new Set(Object.keys(this.document.assets)),
      createId,
      offset,
    );
    if (remapped.elements.length === 0) return;
    const before = this.document;
    this.document = {
      ...this.document,
      elements: [...this.document.elements, ...remapped.elements],
      assets: {
        ...this.document.assets,
        ...Object.fromEntries(
          remapped.assets.map((asset) => [asset.id, asset]),
        ),
      },
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation(kind, before);
    this.selectedElementIds = remapped.elements
      .filter(isElementSelectable)
      .map((element) => element.id);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  private restoreHistoryDocument(document: WhiteboardDocument): void {
    this.document = document;
    this.refreshDocumentSnapshot();
    const selectableIds = new Set(
      this.document.elements
        .filter(isElementSelectable)
        .map((element) => element.id),
    );
    this.selectedElementIds = this.selectedElementIds.filter((id) =>
      selectableIds.has(id),
    );
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error("Whiteboard engine has been destroyed");
    }
  }
}

function elementStyleDiffers(
  element: WhiteboardElement,
  update: WhiteboardElementStyleUpdate,
): boolean {
  const record = element as unknown as Readonly<Record<string, unknown>>;
  return Object.entries(update).some(([key, value]) => record[key] !== value);
}

function styleFromElement(
  element: WhiteboardElement,
  fallback: WhiteboardElementStyle,
): WhiteboardElementStyle {
  const record = element as unknown as Readonly<Record<string, unknown>>;
  return {
    strokeColor: stringValue(record.strokeColor, fallback.strokeColor),
    backgroundColor: stringValue(
      record.backgroundColor,
      fallback.backgroundColor,
    ),
    fillStyle:
      record.fillStyle === "hachure" ||
      record.fillStyle === "cross-hatch" ||
      record.fillStyle === "solid" ||
      record.fillStyle === "zigzag"
        ? record.fillStyle
        : fallback.fillStyle,
    strokeWidth: finiteNumber(record.strokeWidth, fallback.strokeWidth),
    strokeStyle:
      record.strokeStyle === "solid" ||
      record.strokeStyle === "dashed" ||
      record.strokeStyle === "dotted"
        ? record.strokeStyle
        : fallback.strokeStyle,
    opacity: finiteNumber(record.opacity, fallback.opacity),
    roughness: finiteNumber(record.roughness, fallback.roughness ?? 1),
  };
}

function clampZoom(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(OWNED_MAX_ZOOM, Math.max(OWNED_MIN_ZOOM, value));
}

function clampFactor(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(1, value)
    : 0.9;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function shallowRecordEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  const rightRecord = right as Readonly<Record<string, unknown>>;
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => rightRecord[key] === value)
  );
}

function createSerializableSnapshot(
  document: WhiteboardDocument,
): WhiteboardDocument {
  const metadata = {
    name: typeof document.state.name === "string" ? document.state.name : "",
    theme:
      document.state.theme === "dark" ? ("dark" as const) : ("light" as const),
    viewBackgroundColor:
      typeof document.state.viewBackgroundColor === "string"
        ? document.state.viewBackgroundColor
        : "#ffffff",
    gridSize:
      typeof document.state.gridSize === "number" &&
      Number.isFinite(document.state.gridSize)
        ? document.state.gridSize
        : null,
  };
  const validAssets: Record<string, WhiteboardAsset> = {};
  for (const [id, asset] of Object.entries(document.assets)) {
    try {
      createWhiteboardDocumentV1({
        elements: [],
        assets: { [id]: asset },
        metadata,
      });
      validAssets[id] = asset;
    } catch {
      // Invalid legacy assets remain absent until addAssets provides a valid copy.
    }
  }

  const seenIds = new Set<string>();
  const elements = document.elements.flatMap((element) => {
    const record = element as unknown as Readonly<Record<string, unknown>>;
    if (
      typeof record.id !== "string" ||
      typeof record.type !== "string" ||
      seenIds.has(record.id)
    ) {
      return [];
    }
    seenIds.add(record.id);
    const fileId =
      record.fileId === null ||
      record.fileId === undefined ||
      typeof record.fileId === "string"
        ? record.fileId
        : null;
    return [
      {
        ...record,
        id: record.id,
        type: record.type,
        isDeleted: record.isDeleted === true,
        ...(record.type === "image" &&
        typeof fileId === "string" &&
        !validAssets[fileId]
          ? { fileId: null }
          : fileId === undefined
            ? {}
            : { fileId }),
      },
    ];
  });
  const assets = filterReferencedWhiteboardAssets(elements, validAssets);
  const normalized = createWhiteboardDocumentV1({
    elements,
    assets,
    metadata,
  });
  return {
    elements: normalized.elements,
    assets: normalized.assets,
    state: document.state,
    ...(document.persistence ? { persistence: document.persistence } : {}),
  };
}
