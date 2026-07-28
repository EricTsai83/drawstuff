import type {
  WhiteboardAsset,
  OwnedWhiteboardDocument,
  OwnedWhiteboardEditorState,
  OwnedWhiteboardEditorStateUpdate,
  WhiteboardElement,
  WhiteboardTextElementV3,
  WhiteboardElementOrderAction,
  WhiteboardElementStyle,
  WhiteboardElementStyleUpdate,
  WhiteboardEngine,
  WhiteboardImageExportOptions,
  WhiteboardImportResult,
  WhiteboardTool,
  WhiteboardUnsubscribe,
  WhiteboardViewport,
} from "../contracts";
import { filterReferencedWhiteboardAssets } from "../document-assets";
import {
  createPersistedWhiteboardDocumentV3,
  parseWhiteboardDocumentV3,
  toRuntimeWhiteboardDocumentV3,
} from "../v3-document";
import {
  createWhiteboardImageElement,
  importWhiteboardImage,
  isSafeInlineImage,
} from "./assets";
import {
  exportOwnedWhiteboardDocument,
  exportOwnedWhiteboardImage,
} from "./export";
import {
  boundsIntersect,
  getDocumentBounds,
  getElementGeometry,
  isElementSelectable,
  zoomViewportAt,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";
import {
  createOwnedClipboardPayload,
  remapOwnedClipboardPayload,
  type OwnedClipboardPayloadV1,
} from "./clipboard";
import { createOwnedElementId, createOwnedTextElement } from "./drawing";
import { OwnedSpatialIndex } from "./spatial-index";
import {
  commitOwnedElement,
  createOwnedElementRuntimeFields,
  ownedElementIndex,
} from "./element-version";
import { updateBoundLinearElement } from "./bindings";

export const OWNED_MIN_ZOOM = 0.05;
export const OWNED_MAX_ZOOM = 16;
export const OWNED_HISTORY_LIMIT = 100;
export const OWNED_HISTORY_BYTE_LIMIT = 64 * 1024 * 1024;

export type OwnedDocumentCommandKind =
  | "clear"
  | "create"
  | "cut"
  | "delete"
  | "duplicate"
  | "erase"
  | "group"
  | "metadata"
  | "move"
  | "paste"
  | "resize"
  | "reorder"
  | "rotate"
  | "style"
  | "text"
  | "ungroup";

interface OwnedDocumentCommand {
  readonly kind: OwnedDocumentCommandKind;
  readonly before: OwnedDocumentPatch;
  readonly after: OwnedDocumentPatch;
  readonly bytes: number;
}

interface OwnedDocumentPatch {
  readonly elements: ReadonlyMap<string, WhiteboardElement | null>;
  readonly assets: ReadonlyMap<string, WhiteboardAsset | null>;
  readonly order: readonly string[] | null;
  readonly state: Readonly<Record<string, unknown>>;
}

interface ActiveElementGesture {
  readonly kind: "move" | "resize" | "rotate";
  readonly before: OwnedWhiteboardDocument;
  readonly elementIds: ReadonlySet<string>;
  readonly primaryElementIds: ReadonlySet<string>;
  readonly drafts: Map<string, WhiteboardElement>;
}

interface ActiveEraseGesture {
  readonly before: OwnedWhiteboardDocument;
  readonly erasedIds: Set<string>;
}

interface ActiveDuplicateGesture {
  readonly before: OwnedWhiteboardDocument;
  readonly assets: readonly WhiteboardAsset[];
  readonly drafts: Map<string, WhiteboardElement>;
}

const DEFAULT_STYLE: WhiteboardElementStyle = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  opacity: 100,
  roughness: 1,
  roundness: "round",
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

const EMPTY_DOCUMENT: OwnedWhiteboardDocument = {
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
  private document: OwnedWhiteboardDocument = EMPTY_DOCUMENT;
  private documentSnapshot: OwnedWhiteboardDocument = EMPTY_DOCUMENT;
  private documentWithViewportSnapshot: OwnedWhiteboardDocument =
    EMPTY_DOCUMENT;
  private viewport: WhiteboardViewport = DEFAULT_VIEWPORT;
  private activeTool: WhiteboardTool = { type: "selection" };
  private selectedElementIds: readonly string[] = [];
  private elementStyle: WhiteboardElementStyle = DEFAULT_STYLE;
  private readonly documentListeners = new Set<
    (document: OwnedWhiteboardDocument) => void
  >();
  private readonly editorListeners = new Set<
    (state: OwnedWhiteboardEditorState) => void
  >();
  private readonly renderListeners = new Set<OwnedWhiteboardRenderListener>();
  private readonly destroyListeners = new Set<() => void>();
  private readonly accessibilityListeners = new Set<
    (message: string) => void
  >();
  private readonly undoStack: OwnedDocumentCommand[] = [];
  private readonly redoStack: OwnedDocumentCommand[] = [];
  private historyBytes = 0;
  private readonly elementsById = new Map<string, WhiteboardElement>();
  private readonly orderById = new Map<string, number>();
  private readonly reverseBindings = new Map<string, Set<string>>();
  private readonly containerTextIndex = new Map<string, string>();
  private readonly frameChildrenIndex = new Map<string, Set<string>>();
  private readonly groupIndex = new Map<string, Set<string>>();
  private readonly spatialIndex = new OwnedSpatialIndex();
  private sceneVersion = 0;
  private selectionVersion = 0;
  private viewportVersion = 0;
  private viewportTransient = false;
  private textEditing = false;
  private pinching = false;
  private editingGroupId: string | null = null;
  private activeElementGesture: ActiveElementGesture | null = null;
  private activeEraseGesture: ActiveEraseGesture | null = null;
  private activeDuplicateGesture: ActiveDuplicateGesture | null = null;
  private destroyed = false;

  public loadDocument(document: OwnedWhiteboardDocument): void {
    this.assertActive();
    const nextZoom = clampZoom(document.state.zoom?.value, this.viewport.zoom);
    this.document = document;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.historyBytes = 0;
    this.activeElementGesture = null;
    this.activeEraseGesture = null;
    this.activeDuplicateGesture = null;
    this.pinching = false;
    this.editingGroupId = null;
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

  public getDocument(): OwnedWhiteboardDocument {
    this.assertActive();
    return this.getDocumentWithViewport();
  }

  public subscribeDocument(
    listener: (document: OwnedWhiteboardDocument) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.documentListeners.add(listener);
    return () => this.documentListeners.delete(listener);
  }

  public getEditorState(): OwnedWhiteboardEditorState {
    this.assertActive();
    const selectedElements = this.document.elements.filter((element) =>
      this.selectedElementIds.includes(element.id),
    );
    const selectedElement = selectedElements[0];
    const selectedGroupIds = [
      ...new Set(selectedElements.flatMap((element) => element.groupIds)),
    ];
    return {
      activeTool: this.activeTool,
      toolLocked: this.activeTool.locked === true,
      interaction: this.textEditing
        ? "text-editing"
        : this.pinching
          ? "pinching"
          : this.activeDuplicateGesture
            ? "duplicating"
            : this.activeEraseGesture
              ? "erasing"
              : this.activeElementGesture?.kind === "move"
                ? "moving"
                : this.activeElementGesture?.kind === "resize"
                  ? "resizing"
                  : this.activeElementGesture?.kind === "rotate"
                    ? "rotating"
                    : "idle",
      viewport: this.viewport,
      name:
        typeof this.document.state.name === "string"
          ? this.document.state.name
          : "",
      theme: this.document.state.theme === "dark" ? "dark" : "light",
      selectedElementIds: this.selectedElementIds,
      selection: {
        elementIds: this.selectedElementIds,
        groupIds: selectedGroupIds,
        editingGroupId: this.editingGroupId,
      },
      elementStyle: selectedElement
        ? styleFromElement(selectedElement)
        : this.elementStyle,
      selectionStyle:
        selectedElements.length > 0
          ? computedSelectionStyle(selectedElements)
          : null,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      canGroup: selectedElements.length > 1,
      canUngroup: selectedGroupIds.length > 0,
    };
  }

  public subscribeEditorState(
    listener: (state: OwnedWhiteboardEditorState) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.editorListeners.add(listener);
    return () => this.editorListeners.delete(listener);
  }

  public updateEditorState(update: OwnedWhiteboardEditorStateUpdate): void {
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
    const changed = this.activeTool.type !== tool.type;
    this.activeTool = tool;
    this.emitEditor();
    if (changed) this.announce(`Tool changed to ${tool.type}`);
  }

  public setToolLocked(locked: boolean): void {
    this.assertActive();
    if (this.activeTool.locked === locked) return;
    this.activeTool = { ...this.activeTool, locked };
    this.emitEditor();
  }

  public setTextEditing(editing: boolean): void {
    this.assertActive();
    if (this.textEditing === editing) return;
    this.textEditing = editing;
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
            ? commitOwnedElement(element, { ...element, ...update })
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

  public reorderSelection(action: WhiteboardElementOrderAction): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.selectedElementIds.length === 0) return;
    const selectedIds = new Set(this.selectedElementIds);
    const before = this.document;
    const elements = [...this.document.elements];
    if (action === "back" || action === "front") {
      const selected = elements.filter((element) =>
        selectedIds.has(element.id),
      );
      const unselected = elements.filter(
        (element) => !selectedIds.has(element.id),
      );
      elements.splice(
        0,
        elements.length,
        ...(action === "back"
          ? [...selected, ...unselected]
          : [...unselected, ...selected]),
      );
    } else if (action === "backward") {
      for (let index = 1; index < elements.length; index += 1) {
        const current = elements[index];
        const previous = elements[index - 1];
        if (
          current &&
          previous &&
          selectedIds.has(current.id) &&
          !selectedIds.has(previous.id)
        ) {
          elements[index - 1] = current;
          elements[index] = previous;
        }
      }
    } else {
      for (let index = elements.length - 2; index >= 0; index -= 1) {
        const current = elements[index];
        const next = elements[index + 1];
        if (
          current &&
          next &&
          selectedIds.has(current.id) &&
          !selectedIds.has(next.id)
        ) {
          elements[index] = next;
          elements[index + 1] = current;
        }
      }
    }
    if (
      elements.every((element, index) => element === before.elements[index])
    ) {
      return;
    }
    this.document = {
      ...this.document,
      elements: elements.map((element, position) =>
        element.index !== ownedElementIndex(position)
          ? commitOwnedElement(element, {
              ...element,
              index: ownedElementIndex(position),
            })
          : element,
      ),
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("reorder", before);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
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

  public zoomToSelection(): void {
    this.assertActive();
    const bounds = getDocumentBounds(this.getSelectedElements());
    if (!bounds || this.viewport.width <= 0 || this.viewport.height <= 0) {
      return;
    }
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = clampZoom(
      Math.min(
        (this.viewport.width * 0.9) / width,
        (this.viewport.height * 0.9) / height,
      ),
      this.viewport.zoom,
    );
    this.viewport = {
      ...this.viewport,
      zoom,
      x: (this.viewport.width / zoom - width) / 2 - bounds.minX,
      y: (this.viewport.height / zoom - height) / 2 - bounds.minY,
    };
    this.refreshViewportSnapshot();
    this.emitEditor();
    this.emitRender("scene");
  }

  public resetZoom(): void {
    this.assertActive();
    this.updateViewport({ zoom: 1 });
  }

  public cancelInteraction(): void {
    this.assertActive();
    if (this.activeElementGesture) {
      this.cancelElementGesture();
      return;
    }
    if (this.selectedElementIds.length > 0) {
      this.setSelection([]);
    }
  }

  public undo(): void {
    this.assertActive();
    this.cancelElementGesture();
    const command = this.undoStack.pop();
    if (!command) return;
    this.redoStack.push(command);
    this.applyHistoryPatch(command.before);
    this.announce("Undo");
  }

  public redo(): void {
    this.assertActive();
    this.cancelElementGesture();
    const command = this.redoStack.pop();
    if (!command) return;
    this.undoStack.push(command);
    this.applyHistoryPatch(command.after);
    this.announce("Redo");
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
    this.elementsById.clear();
    this.orderById.clear();
    this.reverseBindings.clear();
    this.frameChildrenIndex.clear();
    this.groupIndex.clear();
    this.spatialIndex.clear();
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public appendElement(element: WhiteboardElement): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    const before = this.document;
    const positioned = {
      ...element,
      index: ownedElementIndex(this.document.elements.length),
    };
    this.document = {
      ...this.document,
      elements: [...this.document.elements, positioned],
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("create", before);
    this.selectedElementIds = [positioned.id];
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
    const document = toRuntimeWhiteboardDocumentV3(
      parseWhiteboardDocumentV3(await blob.text()),
    );
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
    this.accessibilityListeners.clear();
    this.document = EMPTY_DOCUMENT;
    this.documentSnapshot = EMPTY_DOCUMENT;
    this.documentWithViewportSnapshot = EMPTY_DOCUMENT;
    this.selectedElementIds = [];
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.historyBytes = 0;
    this.activeElementGesture = null;
    this.activeEraseGesture = null;
    this.activeDuplicateGesture = null;
    this.textEditing = false;
    this.pinching = false;
    this.editingGroupId = null;
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

  public subscribeAccessibilityAnnouncements(
    listener: (message: string) => void,
  ): WhiteboardUnsubscribe {
    this.assertActive();
    this.accessibilityListeners.add(listener);
    return () => this.accessibilityListeners.delete(listener);
  }

  public setSelection(ids: readonly string[]): void {
    this.assertActive();
    const requestedIds = new Set(ids);
    for (const id of ids) {
      for (const memberId of this.getSelectionUnitIds(id)) {
        requestedIds.add(memberId);
      }
    }
    const nextIds = this.document.elements
      .filter(
        (element) =>
          requestedIds.has(element.id) &&
          isElementSelectable(element) &&
          this.isWithinEditingGroup(element),
      )
      .map((element) => element.id);
    if (
      nextIds.length === this.selectedElementIds.length &&
      nextIds.every((id, index) => id === this.selectedElementIds[index])
    ) {
      return;
    }
    this.selectedElementIds = nextIds;
    this.selectionVersion += 1;
    this.emitEditor();
    this.emitRender("overlay");
    this.announce(
      nextIds.length === 0
        ? "Selection cleared"
        : `${nextIds.length} element${nextIds.length === 1 ? "" : "s"} selected`,
    );
  }

  public getSelectionUnitIds(id: string): readonly string[] {
    this.assertActive();
    const element = this.elementsById.get(id);
    if (!element || !this.isWithinEditingGroup(element)) return [];
    const editingGroupIndex = this.editingGroupId
      ? element.groupIds.indexOf(this.editingGroupId)
      : -1;
    const groupId = element.groupIds.slice(editingGroupIndex + 1).at(-1);
    if (!groupId) return element && isElementSelectable(element) ? [id] : [];
    return this.document.elements
      .filter(
        (candidate) =>
          candidate.groupIds.includes(groupId) &&
          this.isWithinEditingGroup(candidate) &&
          isElementSelectable(candidate),
      )
      .map((candidate) => candidate.id);
  }

  public selectAll(): void {
    this.assertActive();
    this.setSelection(
      this.document.elements
        .filter(
          (element) =>
            isElementSelectable(element) && this.isWithinEditingGroup(element),
        )
        .map((element) => element.id),
    );
  }

  public enterGroupEditing(elementId: string): boolean {
    this.assertActive();
    const element = this.elementsById.get(elementId);
    if (!element || !this.isWithinEditingGroup(element)) return false;
    const currentIndex = this.editingGroupId
      ? element.groupIds.indexOf(this.editingGroupId)
      : -1;
    const groupId = element.groupIds.slice(currentIndex + 1).at(-1);
    if (!groupId) return false;
    this.editingGroupId = groupId;
    this.selectedElementIds = this.getSelectionUnitIds(elementId);
    this.selectionVersion += 1;
    this.emitEditor();
    this.emitRender("overlay");
    return true;
  }

  public exitGroupEditing(): boolean {
    this.assertActive();
    const editingGroupId = this.editingGroupId;
    if (!editingGroupId) return false;
    this.editingGroupId = null;
    this.selectedElementIds = [];
    this.selectionVersion += 1;
    this.emitEditor();
    this.emitRender("overlay");
    return true;
  }

  public isElementWithinEditingGroup(element: WhiteboardElement): boolean {
    this.assertActive();
    return this.isWithinEditingGroup(element);
  }

  public getSelectedElements(): readonly WhiteboardElement[] {
    this.assertActive();
    const selectedIds = new Set(this.selectedElementIds);
    const drafts = this.activeElementGesture?.drafts;
    return this.documentSnapshot.elements
      .filter((element) => selectedIds.has(element.id))
      .map((element) => drafts?.get(element.id) ?? element);
  }

  public getTransformElements(
    kind: "move" | "resize" | "rotate",
  ): readonly WhiteboardElement[] {
    this.assertActive();
    const ids = new Set(this.selectedElementIds);
    if (kind === "move") {
      const frames = [...ids].filter(
        (id) => this.elementsById.get(id)?.type === "frame",
      );
      for (const frameId of frames) {
        this.addFrameDescendants(frameId, ids);
      }
    }
    return this.documentSnapshot.elements.filter((element) =>
      ids.has(element.id),
    );
  }

  public getElement(id: string): WhiteboardElement | null {
    this.assertActive();
    return (
      this.activeElementGesture?.drafts.get(id) ??
      this.elementsById.get(id) ??
      null
    );
  }

  public getBoundTextForContainer(
    containerId: string,
  ): WhiteboardTextElementV3 | null {
    this.assertActive();
    const textId = this.containerTextIndex.get(containerId);
    const element = textId ? this.getElement(textId) : null;
    return element?.type === "text" ? element : null;
  }

  public getContainingFrames(
    element: WhiteboardElement,
  ): readonly WhiteboardElement[] {
    this.assertActive();
    return findContainingFrames(
      element,
      this.documentSnapshot.elements.filter(
        (candidate) => candidate.type === "frame",
      ),
    );
  }

  public getFrameAncestors(
    element: WhiteboardElement,
  ): readonly WhiteboardElement[] {
    this.assertActive();
    const frames: WhiteboardElement[] = [];
    const visited = new Set<string>();
    let frameId = element.frameId;
    while (frameId && !visited.has(frameId)) {
      visited.add(frameId);
      const frame = this.elementsById.get(frameId);
      if (frame?.type !== "frame") break;
      frames.unshift(frame);
      frameId = frame.frameId;
    }
    return frames;
  }

  public commitTextEdit(options: {
    readonly targetId: string | null;
    readonly point: WhiteboardPoint;
    readonly text: string;
    readonly width?: number;
    readonly height?: number;
    readonly createId?: () => string;
  }): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    const target = options.targetId
      ? this.elementsById.get(options.targetId)
      : null;
    if (!target) {
      const element = createOwnedTextElement(
        options.point,
        options.text,
        this.elementStyle,
        (options.createId ?? createOwnedElementId)(),
        { width: options.width, height: options.height },
      );
      if (element) this.appendElement(element);
      return;
    }
    const existingText =
      target.type === "text"
        ? target
        : this.getBoundTextForContainer(target.id);
    const trimmed = options.text.trim();
    if (!trimmed && !existingText) return;
    const before = this.document;
    let nextElements = this.document.elements;
    if (!trimmed && existingText) {
      nextElements = nextElements.filter(
        (element) => element.id !== existingText.id,
      );
    } else if (target.type === "text") {
      nextElements = nextElements.map((element) =>
        element.id === target.id
          ? commitOwnedElement(element, {
              ...target,
              text: options.text,
              originalText: options.text,
              width: positiveDimension(options.width, target.width),
              height: positiveDimension(options.height, target.height),
            })
          : element,
      );
    } else {
      const text =
        existingText ??
        createOwnedTextElement(
          options.point,
          options.text,
          this.elementStyle,
          (options.createId ?? createOwnedElementId)(),
          { width: options.width, height: options.height },
        );
      if (text?.type !== "text") return;
      const aligned = alignBoundText(
        {
          ...text,
          text: options.text,
          originalText: options.text,
          containerId: target.id,
          frameId: target.frameId,
          index: existingText
            ? text.index
            : ownedElementIndex(this.document.elements.length),
          width: positiveDimension(options.width, text.width),
          height: positiveDimension(options.height, text.height),
        },
        target,
      );
      nextElements = existingText
        ? nextElements.map((element) =>
            element.id === existingText.id
              ? commitOwnedElement(existingText, aligned)
              : element,
          )
        : [...nextElements, aligned];
    }
    this.document = { ...this.document, elements: nextElements };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("text", before);
    this.selectedElementIds = [target.id];
    if (!this.activeTool.locked) this.activeTool = { type: "selection" };
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public getVisibleElements(
    bounds: WhiteboardBounds,
  ): readonly WhiteboardElement[] {
    this.assertActive();
    const ids = this.spatialIndex.query(bounds);
    const drafts = this.activeElementGesture?.drafts;
    return [...ids]
      .flatMap((id) => {
        const element = drafts?.get(id) ?? this.elementsById.get(id);
        if (!element || element.isDeleted) return [];
        const geometry = getElementGeometry(element);
        return geometry && boundsIntersect(geometry.bounds, bounds)
          ? [element]
          : [];
      })
      .sort(
        (left, right) =>
          (this.orderById.get(left.id) ?? 0) -
          (this.orderById.get(right.id) ?? 0),
      );
  }

  public getCommittedVisibleElements(
    bounds: WhiteboardBounds,
  ): readonly WhiteboardElement[] {
    this.assertActive();
    const excluded = this.activeElementGesture?.elementIds;
    return [...this.spatialIndex.query(bounds)]
      .flatMap((id) => {
        if (excluded?.has(id)) return [];
        const element = this.elementsById.get(id);
        if (!element || element.isDeleted) return [];
        const geometry = getElementGeometry(element);
        return geometry && boundsIntersect(geometry.bounds, bounds)
          ? [element]
          : [];
      })
      .sort(
        (left, right) =>
          (this.orderById.get(left.id) ?? 0) -
          (this.orderById.get(right.id) ?? 0),
      );
  }

  public getCommittedElements(): readonly WhiteboardElement[] {
    this.assertActive();
    const excluded = this.activeElementGesture?.elementIds;
    return excluded
      ? this.document.elements.filter((element) => !excluded.has(element.id))
      : this.document.elements;
  }

  public getGestureDrafts(): readonly WhiteboardElement[] {
    this.assertActive();
    const drafts =
      this.activeElementGesture?.drafts ?? this.activeDuplicateGesture?.drafts;
    if (!drafts) {
      return [];
    }
    return [...drafts.values()].sort(
      (left, right) =>
        (this.orderById.get(left.id) ?? 0) -
        (this.orderById.get(right.id) ?? 0),
    );
  }

  public getErasedPreviewElements(): readonly WhiteboardElement[] {
    this.assertActive();
    const ids = this.activeEraseGesture?.erasedIds;
    return ids
      ? this.document.elements.filter((element) => ids.has(element.id))
      : [];
  }

  public createClipboardPayload(): OwnedClipboardPayloadV1 | null {
    this.assertActive();
    const selectedIds = new Set(
      this.getSelectedElements().map((element) => element.id),
    );
    for (const id of [...selectedIds]) {
      const textId = this.containerTextIndex.get(id);
      if (textId) selectedIds.add(textId);
    }
    const elements = this.documentSnapshot.elements.filter((element) =>
      selectedIds.has(element.id),
    );
    return elements.length > 0
      ? createOwnedClipboardPayload(elements, this.documentSnapshot.assets)
      : null;
  }

  public deleteSelection(kind: "cut" | "delete" = "delete"): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.selectedElementIds.length === 0) return;
    const selectedIds = new Set(this.selectedElementIds);
    for (const id of [...selectedIds]) {
      if (this.elementsById.get(id)?.type === "frame") {
        this.addFrameDescendants(id, selectedIds);
      }
    }
    for (const id of selectedIds) {
      const textId = this.containerTextIndex.get(id);
      if (textId) selectedIds.add(textId);
    }
    const before = this.document;
    this.document = {
      ...this.document,
      elements: this.document.elements.flatMap((element) => {
        if (selectedIds.has(element.id)) return [];
        if (element.type !== "arrow" && element.type !== "line") {
          return [element];
        }
        const startBinding =
          element.startBinding &&
          selectedIds.has(element.startBinding.elementId)
            ? null
            : element.startBinding;
        const endBinding =
          element.endBinding && selectedIds.has(element.endBinding.elementId)
            ? null
            : element.endBinding;
        return startBinding !== element.startBinding ||
          endBinding !== element.endBinding
          ? [
              commitOwnedElement(element, {
                ...element,
                startBinding,
                endBinding,
              }),
            ]
          : [element];
      }),
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation(kind, before);
    this.selectedElementIds = [];
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
    this.announce(
      `${selectedIds.size} element${selectedIds.size === 1 ? "" : "s"} deleted`,
    );
  }

  public duplicateSelection(
    createId: () => string = createOwnedElementId,
    offset = 20,
  ): void {
    const payload = this.createClipboardPayload();
    if (!payload) return;
    this.insertClipboardPayload(payload, createId, offset, "duplicate");
  }

  public groupSelection(): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.selectedElementIds.length < 2) return;
    const selectedIds = new Set(this.selectedElementIds);
    const groupId = createOwnedElementId();
    const before = this.document;
    this.document = {
      ...this.document,
      elements: this.document.elements.map((element) =>
        selectedIds.has(element.id)
          ? commitOwnedElement(element, {
              ...element,
              groupIds: [...element.groupIds, groupId],
            })
          : element,
      ),
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("group", before);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
    this.announce(`Grouped ${selectedIds.size} elements`);
  }

  public ungroupSelection(): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.selectedElementIds.length === 0) return;
    const selectedIds = new Set(this.selectedElementIds);
    const selectedGroups = new Set(
      this.document.elements.flatMap((element) =>
        selectedIds.has(element.id) ? element.groupIds : [],
      ),
    );
    if (selectedGroups.size === 0) return;
    const before = this.document;
    this.document = {
      ...this.document,
      elements: this.document.elements.map((element) =>
        element.groupIds.some((groupId) => selectedGroups.has(groupId))
          ? commitOwnedElement(element, {
              ...element,
              groupIds: element.groupIds.filter(
                (groupId) => !selectedGroups.has(groupId),
              ),
            })
          : element,
      ),
    };
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("ungroup", before);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
    this.announce("Ungrouped selection");
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
    const primaryElements = this.getTransformElements(kind);
    const primaryElementIds = new Set(
      primaryElements.map((element) => element.id),
    );
    const elementIds = new Set(primaryElementIds);
    for (const id of primaryElementIds) {
      const textId = this.containerTextIndex.get(id);
      if (textId) elementIds.add(textId);
      for (const arrowId of this.reverseBindings.get(id) ?? []) {
        elementIds.add(arrowId);
      }
    }
    this.activeElementGesture = {
      kind,
      before: this.document,
      elementIds,
      primaryElementIds,
      drafts: new Map(),
    };
    this.emitEditor();
    this.emitRender("scene");
  }

  public beginEraseGesture(): void {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.activeEraseGesture) return;
    this.activeEraseGesture = {
      before: this.document,
      erasedIds: new Set(),
    };
    this.emitEditor();
    this.emitRender("overlay");
  }

  public beginDuplicateGesture(
    createId: () => string = createOwnedElementId,
  ): readonly WhiteboardElement[] {
    this.assertActive();
    this.finalizeActiveElementGesture();
    if (this.activeDuplicateGesture || this.selectedElementIds.length === 0) {
      return [];
    }
    const payload = this.createClipboardPayload();
    if (!payload) return [];
    const duplicated = remapOwnedClipboardPayload(
      payload,
      new Set(this.document.elements.map(({ id }) => id)),
      new Set(Object.keys(this.document.assets)),
      createId,
      0,
    );
    const drafts = new Map(
      duplicated.elements.map((element) => [element.id, element]),
    );
    this.activeDuplicateGesture = {
      before: this.document,
      assets: duplicated.assets,
      drafts,
    };
    this.emitEditor();
    this.emitRender("overlay");
    return [...drafts.values()];
  }

  public updateDuplicateGesture(elements: readonly WhiteboardElement[]): void {
    this.assertActive();
    const gesture = this.activeDuplicateGesture;
    if (!gesture) return;
    for (const element of elements) {
      if (gesture.drafts.has(element.id)) {
        gesture.drafts.set(element.id, element);
      }
    }
    this.emitRender("overlay");
  }

  public commitDuplicateGesture(): void {
    this.assertActive();
    const gesture = this.activeDuplicateGesture;
    if (!gesture) return;
    this.activeDuplicateGesture = null;
    const position = this.document.elements.length;
    const elements = [...gesture.drafts.values()].map((element, offset) => ({
      ...element,
      index: ownedElementIndex(position + offset),
    }));
    this.document = {
      ...this.document,
      elements: [...this.document.elements, ...elements],
      assets: {
        ...this.document.assets,
        ...Object.fromEntries(gesture.assets.map((asset) => [asset.id, asset])),
      },
    };
    this.selectedElementIds = elements
      .filter(isElementSelectable)
      .map(({ id }) => id);
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("duplicate", gesture.before);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
  }

  public cancelDuplicateGesture(): void {
    this.assertActive();
    if (!this.activeDuplicateGesture) return;
    this.activeDuplicateGesture = null;
    this.emitEditor();
    this.emitRender("overlay");
  }

  public updateEraseGesture(
    start: WhiteboardPoint,
    end: WhiteboardPoint,
    radius: number,
  ): readonly string[] {
    this.assertActive();
    const gesture = this.activeEraseGesture;
    if (!gesture) return [];
    const safeRadius = Math.max(0, finiteNumber(radius, 0));
    const sweep = {
      minX: Math.min(start.x, end.x) - safeRadius,
      minY: Math.min(start.y, end.y) - safeRadius,
      maxX: Math.max(start.x, end.x) + safeRadius,
      maxY: Math.max(start.y, end.y) + safeRadius,
    };
    let changed = false;
    for (const id of this.spatialIndex.query(sweep)) {
      const element = this.elementsById.get(id);
      const geometry = element ? getElementGeometry(element) : null;
      if (
        !element ||
        !geometry ||
        !isElementSelectable(element) ||
        !segmentHitsBounds(start, end, geometry.bounds, safeRadius)
      ) {
        continue;
      }
      changed =
        addErasedDependencies(
          id,
          gesture.erasedIds,
          this.elementsById,
          this.containerTextIndex,
          this.frameChildrenIndex,
        ) || changed;
    }
    if (changed) this.emitRender("overlay");
    return [...gesture.erasedIds];
  }

  public commitEraseGesture(): void {
    this.assertActive();
    const gesture = this.activeEraseGesture;
    if (!gesture) return;
    this.activeEraseGesture = null;
    if (gesture.erasedIds.size === 0) {
      this.emitEditor();
      this.emitRender("overlay");
      return;
    }
    const erasedIds = gesture.erasedIds;
    this.document = {
      ...this.document,
      elements: this.document.elements.flatMap((element) => {
        if (erasedIds.has(element.id)) return [];
        if (element.type !== "arrow" && element.type !== "line") {
          return [element];
        }
        const startBinding =
          element.startBinding && erasedIds.has(element.startBinding.elementId)
            ? null
            : element.startBinding;
        const endBinding =
          element.endBinding && erasedIds.has(element.endBinding.elementId)
            ? null
            : element.endBinding;
        return startBinding !== element.startBinding ||
          endBinding !== element.endBinding
          ? [
              commitOwnedElement(element, {
                ...element,
                startBinding,
                endBinding,
              }),
            ]
          : [element];
      }),
    };
    this.selectedElementIds = this.selectedElementIds.filter(
      (id) => !erasedIds.has(id),
    );
    this.refreshDocumentSnapshot();
    this.recordDocumentMutation("erase", gesture.before);
    this.emitDocument();
    this.emitEditor();
    this.emitRender("scene");
    this.announce(
      `${erasedIds.size} element${erasedIds.size === 1 ? "" : "s"} deleted`,
    );
  }

  public cancelEraseGesture(): void {
    this.assertActive();
    if (!this.activeEraseGesture) return;
    this.activeEraseGesture = null;
    this.emitEditor();
    this.emitRender("overlay");
  }

  public updateElementGesture(elements: readonly WhiteboardElement[]): void {
    this.assertActive();
    const gesture = this.activeElementGesture;
    if (!gesture) return;
    let changed = false;
    for (const element of elements) {
      if (!gesture.primaryElementIds.has(element.id)) continue;
      gesture.drafts.set(element.id, element);
      const geometry = getElementGeometry(element);
      if (geometry) this.spatialIndex.update(element.id, geometry.bounds);
      changed = true;
    }
    if (!changed) return;
    this.synchronizeGestureDependencies(gesture);
    this.emitRender("overlay");
  }

  public commitElementGesture(): void {
    this.assertActive();
    const gesture = this.activeElementGesture;
    if (!gesture) return;
    this.activeElementGesture = null;
    this.activeEraseGesture = null;
    if (gesture.drafts.size === 0) {
      this.emitEditor();
      this.emitRender("scene");
      return;
    }
    const draftElements = this.applyFrameReparenting(gesture);
    this.document = {
      ...this.document,
      elements: this.document.elements.map((element) => {
        const draft = draftElements.get(element.id);
        return draft ? commitOwnedElement(element, draft) : element;
      }),
    };
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
    for (const id of gesture.elementIds) {
      const element = this.elementsById.get(id);
      const geometry = element ? getElementGeometry(element) : null;
      if (geometry) this.spatialIndex.update(id, geometry.bounds);
    }
    this.emitEditor();
    this.emitRender("scene");
  }

  public getHistoryDiagnostics(): {
    readonly undoEntries: number;
    readonly redoEntries: number;
    readonly limit: number;
    readonly undoKinds: readonly OwnedDocumentCommandKind[];
    readonly bytes: number;
    readonly byteLimit: number;
  } {
    this.assertActive();
    return {
      undoEntries: this.undoStack.length,
      redoEntries: this.redoStack.length,
      limit: OWNED_HISTORY_LIMIT,
      undoKinds: this.undoStack.map((command) => command.kind),
      bytes: this.historyBytes,
      byteLimit: OWNED_HISTORY_BYTE_LIMIT,
    };
  }

  public getIndexDiagnostics(): {
    readonly sceneVersion: number;
    readonly selectionVersion: number;
    readonly viewportVersion: number;
    readonly elements: number;
    readonly reverseBindingTargets: number;
    readonly frames: number;
    readonly groups: number;
    readonly spatial: ReturnType<OwnedSpatialIndex["getDiagnostics"]>;
  } {
    this.assertActive();
    return {
      sceneVersion: this.sceneVersion,
      selectionVersion: this.selectionVersion,
      viewportVersion: this.viewportVersion,
      elements: this.elementsById.size,
      reverseBindingTargets: this.reverseBindings.size,
      frames: this.frameChildrenIndex.size,
      groups: this.groupIndex.size,
      spatial: this.spatialIndex.getDiagnostics(),
    };
  }

  public getRasterCacheDependencies(element: WhiteboardElement): {
    readonly assetRevision: number;
    readonly boundTextNonce: number;
    readonly frameOpacity: number;
  } {
    this.assertActive();
    const assetRevision =
      element.type === "image" && element.fileId
        ? (this.document.assets[element.fileId]?.revision ?? 0)
        : 0;
    const textId = this.containerTextIndex.get(element.id);
    const text = textId ? this.elementsById.get(textId) : null;
    let frameOpacity = 100;
    let frameId = element.frameId;
    const visited = new Set<string>();
    while (frameId && !visited.has(frameId)) {
      visited.add(frameId);
      const frame = this.elementsById.get(frameId);
      if (frame?.type !== "frame") break;
      frameOpacity *= Math.max(0, Math.min(100, frame.opacity)) / 100;
      frameId = frame.frameId;
    }
    return {
      assetRevision,
      boundTextNonce: text?.versionNonce ?? 0,
      frameOpacity,
    };
  }

  public panBy(deltaX: number, deltaY: number, transient = false): void {
    this.assertActive();
    this.viewport = {
      ...this.viewport,
      x: this.viewport.x + finiteNumber(deltaX, 0) / this.viewport.zoom,
      y: this.viewport.y + finiteNumber(deltaY, 0) / this.viewport.zoom,
    };
    this.viewportTransient = transient;
    this.refreshViewportSnapshot();
    this.viewportVersion += 1;
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
    this.viewportTransient = transient;
    this.refreshViewportSnapshot();
    this.viewportVersion += 1;
    if (!transient) this.emitEditor();
    this.emitRender("scene");
  }

  public commitTransientViewport(): void {
    this.assertActive();
    this.viewportTransient = false;
    this.emitEditor();
    this.emitRender("scene");
  }

  public beginPinchGesture(): void {
    this.assertActive();
    this.pinching = true;
    this.viewportTransient = true;
    this.emitEditor();
  }

  public updatePinchViewport(
    update: Pick<WhiteboardViewport, "x" | "y" | "zoom">,
  ): void {
    this.assertActive();
    this.viewport = {
      ...this.viewport,
      x: finiteNumber(update.x, this.viewport.x),
      y: finiteNumber(update.y, this.viewport.y),
      zoom: clampZoom(update.zoom, this.viewport.zoom),
    };
    this.viewportTransient = true;
    this.refreshViewportSnapshot();
    this.viewportVersion += 1;
    this.emitRender("scene");
  }

  public endPinchGesture(): void {
    this.assertActive();
    if (!this.pinching) return;
    this.pinching = false;
    this.commitTransientViewport();
  }

  public isViewportTransient(): boolean {
    return this.viewportTransient;
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
    this.rebuildIndexes();
    this.sceneVersion += 1;
    this.refreshViewportSnapshot();
  }

  private getDocumentWithViewport(): OwnedWhiteboardDocument {
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

  private rebuildIndexes(): void {
    this.elementsById.clear();
    this.orderById.clear();
    this.reverseBindings.clear();
    this.containerTextIndex.clear();
    this.frameChildrenIndex.clear();
    this.groupIndex.clear();
    this.spatialIndex.clear();
    this.documentSnapshot.elements.forEach((element, order) => {
      this.elementsById.set(element.id, element);
      this.orderById.set(element.id, order);
      const geometry = getElementGeometry(element);
      if (geometry && !element.isDeleted) {
        this.spatialIndex.insert(element.id, geometry.bounds);
      }
      if (element.frameId) {
        addIndexValue(this.frameChildrenIndex, element.frameId, element.id);
      }
      if (element.type === "text" && element.containerId) {
        this.containerTextIndex.set(element.containerId, element.id);
      }
      for (const groupId of element.groupIds) {
        addIndexValue(this.groupIndex, groupId, element.id);
      }
      if (element.type === "arrow" || element.type === "line") {
        if (element.startBinding) {
          addIndexValue(
            this.reverseBindings,
            element.startBinding.elementId,
            element.id,
          );
        }
        if (element.endBinding) {
          addIndexValue(
            this.reverseBindings,
            element.endBinding.elementId,
            element.id,
          );
        }
      }
    });
  }

  private addFrameDescendants(frameId: string, ids: Set<string>): void {
    for (const childId of this.frameChildrenIndex.get(frameId) ?? []) {
      if (ids.has(childId)) continue;
      ids.add(childId);
      if (this.elementsById.get(childId)?.type === "frame") {
        this.addFrameDescendants(childId, ids);
      }
    }
  }

  private isWithinEditingGroup(element: WhiteboardElement): boolean {
    return (
      this.editingGroupId === null ||
      element.groupIds.includes(this.editingGroupId)
    );
  }

  private announce(message: string): void {
    for (const listener of this.accessibilityListeners) listener(message);
  }

  private synchronizeGestureDependencies(gesture: ActiveElementGesture): void {
    for (const targetId of gesture.primaryElementIds) {
      const target =
        gesture.drafts.get(targetId) ?? this.elementsById.get(targetId);
      const original = this.elementsById.get(targetId);
      if (!target || !original) {
        continue;
      }
      const textId = this.containerTextIndex.get(targetId);
      const text = textId ? this.elementsById.get(textId) : null;
      if (text?.type === "text") {
        const dependent =
          gesture.kind === "move"
            ? {
                ...text,
                x: text.x + (target.x - original.x),
                y: text.y + (target.y - original.y),
                angle: target.angle,
                frameId: target.frameId,
              }
            : alignBoundText(text, target);
        gesture.drafts.set(text.id, dependent);
        this.updateDraftSpatialBounds(dependent);
      }
      for (const arrowId of this.reverseBindings.get(targetId) ?? []) {
        if (gesture.primaryElementIds.has(arrowId)) continue;
        const arrow =
          gesture.drafts.get(arrowId) ?? this.elementsById.get(arrowId);
        if (!arrow || (arrow.type !== "arrow" && arrow.type !== "line")) {
          continue;
        }
        const targets = new Map<string, WhiteboardElement>();
        for (const binding of [arrow.startBinding, arrow.endBinding]) {
          if (!binding) continue;
          const bindingTarget =
            gesture.drafts.get(binding.elementId) ??
            this.elementsById.get(binding.elementId);
          if (bindingTarget) targets.set(binding.elementId, bindingTarget);
        }
        targets.set(targetId, target);
        const dependent = updateBoundLinearElement(arrow, targets);
        gesture.drafts.set(arrow.id, dependent);
        this.updateDraftSpatialBounds(dependent);
      }
    }
  }

  private applyFrameReparenting(
    gesture: ActiveElementGesture,
  ): Map<string, WhiteboardElement> {
    const drafts = new Map(gesture.drafts);
    const scene = this.document.elements.map(
      (element) => drafts.get(element.id) ?? element,
    );
    const frames = scene.filter((element) => element.type === "frame");
    for (const id of gesture.primaryElementIds) {
      const element = drafts.get(id);
      if (!element) {
        continue;
      }
      const frameId = findContainingFrames(element, frames).at(0)?.id ?? null;
      if (element.frameId !== frameId) {
        drafts.set(id, { ...element, frameId });
      }
      const textId = this.containerTextIndex.get(id);
      const text = textId ? drafts.get(textId) : null;
      if (text?.type === "text" && text.frameId !== frameId) {
        drafts.set(text.id, { ...text, frameId });
      }
    }
    return drafts;
  }

  private updateDraftSpatialBounds(element: WhiteboardElement): void {
    const geometry = getElementGeometry(element);
    if (geometry) this.spatialIndex.update(element.id, geometry.bounds);
  }

  private recordDocumentMutation(
    kind: OwnedDocumentCommandKind,
    before: OwnedWhiteboardDocument,
  ): void {
    if (before === this.document) return;
    const command = createDocumentCommand(kind, before, this.document);
    if (!command) return;
    this.historyBytes -= this.redoStack.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    this.redoStack.length = 0;
    this.undoStack.push(command);
    this.historyBytes += command.bytes;
    while (
      this.undoStack.length > OWNED_HISTORY_LIMIT ||
      this.historyBytes > OWNED_HISTORY_BYTE_LIMIT
    ) {
      const evicted = this.undoStack.shift();
      if (!evicted) break;
      this.historyBytes = Math.max(0, this.historyBytes - evicted.bytes);
    }
  }

  private finalizeActiveElementGesture(): void {
    if (this.activeElementGesture) this.commitElementGesture();
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

  private applyHistoryPatch(patch: OwnedDocumentPatch): void {
    const elements = new Map(
      this.document.elements.map((element) => [element.id, element]),
    );
    for (const [id, element] of patch.elements) {
      if (element) elements.set(id, element);
      else elements.delete(id);
    }
    const order = patch.order ?? this.document.elements.map(({ id }) => id);
    const assets = { ...this.document.assets };
    for (const [id, asset] of patch.assets) {
      if (asset) assets[id] = asset;
      else delete assets[id];
    }
    this.document = {
      elements: order.flatMap((id) => {
        const element = elements.get(id);
        return element ? [element] : [];
      }),
      assets,
      state: { ...this.document.state, ...patch.state },
    };
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
  return (
    (update.strokeColor !== undefined &&
      update.strokeColor !== element.strokeColor) ||
    (update.backgroundColor !== undefined &&
      update.backgroundColor !== element.backgroundColor) ||
    (update.fillStyle !== undefined &&
      update.fillStyle !== element.fillStyle) ||
    (update.strokeWidth !== undefined &&
      update.strokeWidth !== element.strokeWidth) ||
    (update.strokeStyle !== undefined &&
      update.strokeStyle !== element.strokeStyle) ||
    (update.opacity !== undefined && update.opacity !== element.opacity) ||
    (update.roughness !== undefined &&
      update.roughness !== element.roughness) ||
    (update.roundness !== undefined && update.roundness !== element.roundness)
  );
}

function styleFromElement(element: WhiteboardElement): WhiteboardElementStyle {
  return {
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    opacity: element.opacity,
    roughness: element.roughness,
    roundness: element.roundness ?? "sharp",
  };
}

function computedSelectionStyle(
  elements: readonly WhiteboardElement[],
): OwnedWhiteboardEditorState["selectionStyle"] {
  const first = elements[0];
  if (!first) return null;
  const mixed = <K extends keyof WhiteboardElementStyle>(
    key: K,
  ): WhiteboardElementStyle[K] | "mixed" => {
    const value = styleFromElement(first)[key];
    return elements.every((element) => styleFromElement(element)[key] === value)
      ? value
      : "mixed";
  };
  return {
    strokeColor: mixed("strokeColor"),
    backgroundColor: mixed("backgroundColor"),
    fillStyle: mixed("fillStyle"),
    strokeWidth: mixed("strokeWidth"),
    strokeStyle: mixed("strokeStyle"),
    opacity: mixed("opacity"),
    roughness: elements.every(
      (element) => element.roughness === first.roughness,
    )
      ? first.roughness
      : "mixed",
    roundness: mixed("roundness"),
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
  document: OwnedWhiteboardDocument,
): OwnedWhiteboardDocument {
  const validAssets: Record<string, WhiteboardAsset> = {};
  for (const [id, asset] of Object.entries(document.assets)) {
    if (isSerializableAsset(id, asset)) {
      validAssets[id] = asset;
    }
  }

  const seenIds = new Set<string>();
  const elements = document.elements.flatMap((element) => {
    if (seenIds.has(element.id)) {
      return [];
    }
    seenIds.add(element.id);
    return element.type === "image" &&
      typeof element.fileId === "string" &&
      !validAssets[element.fileId]
      ? [{ ...element, fileId: null }]
      : [element];
  });
  const assets = filterReferencedWhiteboardAssets(elements, validAssets);
  return {
    elements,
    assets,
    state: document.state,
  };
}

function isSerializableAsset(id: string, asset: WhiteboardAsset): boolean {
  if (asset.id !== id || !isSafeInlineImage(asset)) return false;
  try {
    createPersistedWhiteboardDocumentV3({
      elements: [
        {
          ...createOwnedElementRuntimeFields(`asset-validation-${id}`),
          id: `asset-validation-${id}`,
          type: "image",
          isDeleted: false,
          fileId: id,
          status: "saved",
          scale: [1, 1],
          crop: null,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          angle: 0,
          strokeColor: "transparent",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          opacity: 100,
          roughness: 0,
          locked: false,
        },
      ],
      assets: { [id]: asset },
      state: {
        name: "",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function addIndexValue(
  index: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
}

function alignBoundText(
  text: WhiteboardTextElementV3,
  container: WhiteboardElement,
): WhiteboardTextElementV3 {
  const availableWidth = Math.max(1, container.width - 16);
  const width = text.autoResize
    ? Math.min(text.width, availableWidth)
    : availableWidth;
  const height = Math.min(text.height, Math.max(1, container.height - 16));
  return {
    ...text,
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
    angle: container.angle,
    frameId: container.frameId,
    containerId: container.id,
    textAlign: "center",
    verticalAlign: "middle",
  };
}

function findContainingFrames(
  element: WhiteboardElement,
  frames: readonly WhiteboardElement[],
): readonly WhiteboardElement[] {
  const geometry = getElementGeometry(element);
  if (!geometry) return [];
  const framesById = new Map(frames.map((frame) => [frame.id, frame]));
  const wouldCreateCycle = (frame: WhiteboardElement): boolean => {
    const visited = new Set<string>();
    let frameId = frame.frameId;
    while (frameId && !visited.has(frameId)) {
      if (frameId === element.id) return true;
      visited.add(frameId);
      frameId = framesById.get(frameId)?.frameId ?? null;
    }
    return false;
  };
  const depth = (frame: WhiteboardElement): number => {
    let result = 0;
    const visited = new Set<string>();
    let frameId = frame.frameId;
    while (frameId && !visited.has(frameId)) {
      visited.add(frameId);
      result += 1;
      frameId = framesById.get(frameId)?.frameId ?? null;
    }
    return result;
  };
  return frames
    .filter((frame) => {
      if (
        frame.id === element.id ||
        frame.type !== "frame" ||
        wouldCreateCycle(frame)
      ) {
        return false;
      }
      const bounds = getElementGeometry(frame)?.bounds;
      return (
        bounds !== undefined &&
        geometry.bounds.minX >= bounds.minX &&
        geometry.bounds.maxX <= bounds.maxX &&
        geometry.bounds.minY >= bounds.minY &&
        geometry.bounds.maxY <= bounds.maxY
      );
    })
    .sort((left, right) => {
      const depthDifference = depth(right) - depth(left);
      return depthDifference !== 0
        ? depthDifference
        : left.width * left.height - right.width * right.height;
    });
}

function positiveDimension(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Math.max(1, fallback);
}

function addErasedDependencies(
  id: string,
  erasedIds: Set<string>,
  elementsById: ReadonlyMap<string, WhiteboardElement>,
  containerTextIndex: ReadonlyMap<string, string>,
  frameChildrenIndex: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (erasedIds.has(id)) return false;
  erasedIds.add(id);
  const element = elementsById.get(id);
  if (!element) return true;
  const textId = containerTextIndex.get(id);
  if (textId)
    addErasedDependencies(
      textId,
      erasedIds,
      elementsById,
      containerTextIndex,
      frameChildrenIndex,
    );
  if (element.type === "frame") {
    for (const childId of frameChildrenIndex.get(id) ?? []) {
      addErasedDependencies(
        childId,
        erasedIds,
        elementsById,
        containerTextIndex,
        frameChildrenIndex,
      );
    }
  }
  return true;
}

function segmentHitsBounds(
  start: WhiteboardPoint,
  end: WhiteboardPoint,
  bounds: WhiteboardBounds,
  radius: number,
): boolean {
  const expanded = {
    minX: bounds.minX - radius,
    minY: bounds.minY - radius,
    maxX: bounds.maxX + radius,
    maxY: bounds.maxY + radius,
  };
  if (pointInsideBounds(start, expanded) || pointInsideBounds(end, expanded)) {
    return true;
  }
  const corners = [
    { x: expanded.minX, y: expanded.minY },
    { x: expanded.maxX, y: expanded.minY },
    { x: expanded.maxX, y: expanded.maxY },
    { x: expanded.minX, y: expanded.maxY },
  ];
  return corners.some((corner, index) =>
    segmentsIntersect(
      start,
      end,
      corner,
      corners[(index + 1) % corners.length]!,
    ),
  );
}

function pointInsideBounds(
  point: WhiteboardPoint,
  bounds: WhiteboardBounds,
): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

function segmentsIntersect(
  firstStart: WhiteboardPoint,
  firstEnd: WhiteboardPoint,
  secondStart: WhiteboardPoint,
  secondEnd: WhiteboardPoint,
): boolean {
  const cross = (
    origin: WhiteboardPoint,
    left: WhiteboardPoint,
    right: WhiteboardPoint,
  ) =>
    (left.x - origin.x) * (right.y - origin.y) -
    (left.y - origin.y) * (right.x - origin.x);
  const firstA = cross(firstStart, firstEnd, secondStart);
  const firstB = cross(firstStart, firstEnd, secondEnd);
  const secondA = cross(secondStart, secondEnd, firstStart);
  const secondB = cross(secondStart, secondEnd, firstEnd);
  return firstA * firstB <= 0 && secondA * secondB <= 0;
}

function createDocumentCommand(
  kind: OwnedDocumentCommandKind,
  before: OwnedWhiteboardDocument,
  after: OwnedWhiteboardDocument,
): OwnedDocumentCommand | null {
  const beforeElements = new Map(
    before.elements.map((element) => [element.id, element]),
  );
  const afterElements = new Map(
    after.elements.map((element) => [element.id, element]),
  );
  const elementIds = new Set([
    ...beforeElements.keys(),
    ...afterElements.keys(),
  ]);
  const beforeElementPatch = new Map<string, WhiteboardElement | null>();
  const afterElementPatch = new Map<string, WhiteboardElement | null>();
  for (const id of elementIds) {
    const previous = beforeElements.get(id) ?? null;
    const next = afterElements.get(id) ?? null;
    if (previous === next) continue;
    beforeElementPatch.set(id, previous);
    afterElementPatch.set(id, next);
  }

  const assetIds = new Set([
    ...Object.keys(before.assets),
    ...Object.keys(after.assets),
  ]);
  const beforeAssetPatch = new Map<string, WhiteboardAsset | null>();
  const afterAssetPatch = new Map<string, WhiteboardAsset | null>();
  for (const id of assetIds) {
    const previous = before.assets[id] ?? null;
    const next = after.assets[id] ?? null;
    if (previous === next) continue;
    beforeAssetPatch.set(id, previous);
    afterAssetPatch.set(id, next);
  }

  const beforeOrder = before.elements.map(({ id }) => id);
  const afterOrder = after.elements.map(({ id }) => id);
  const orderChanged =
    beforeOrder.length !== afterOrder.length ||
    beforeOrder.some((id, index) => id !== afterOrder[index]);
  const [beforeState, afterState] = statePatches(before.state, after.state);
  if (
    beforeElementPatch.size === 0 &&
    beforeAssetPatch.size === 0 &&
    !orderChanged &&
    Object.keys(beforeState).length === 0
  ) {
    return null;
  }
  const beforePatch: OwnedDocumentPatch = {
    elements: beforeElementPatch,
    assets: beforeAssetPatch,
    order: orderChanged ? beforeOrder : null,
    state: beforeState,
  };
  const afterPatch: OwnedDocumentPatch = {
    elements: afterElementPatch,
    assets: afterAssetPatch,
    order: orderChanged ? afterOrder : null,
    state: afterState,
  };
  return {
    kind,
    before: beforePatch,
    after: afterPatch,
    bytes: estimatePatchBytes(beforePatch) + estimatePatchBytes(afterPatch),
  };
}

function statePatches(
  before: OwnedWhiteboardDocument["state"],
  after: OwnedWhiteboardDocument["state"],
): readonly [
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>,
] {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforeValue = (before as Readonly<Record<string, unknown>>)[key];
    const afterValue = (after as Readonly<Record<string, unknown>>)[key];
    if (beforeValue === afterValue) continue;
    previous[key] = beforeValue;
    next[key] = afterValue;
  }
  return [previous, next];
}

function estimatePatchBytes(patch: OwnedDocumentPatch): number {
  const json = JSON.stringify({
    elements: [...patch.elements],
    assets: [...patch.assets],
    order: patch.order,
    state: patch.state,
  });
  return json.length * 2;
}
