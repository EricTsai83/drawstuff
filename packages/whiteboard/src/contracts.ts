/** Public contracts for the framework-independent whiteboard engine. */
export type WhiteboardTheme = "light" | "dark";

export type WhiteboardElementType =
  | "arrow"
  | "diamond"
  | "ellipse"
  | "embeddable"
  | "frame"
  | "freedraw"
  | "iframe"
  | "image"
  | "line"
  | "magicframe"
  | "rectangle"
  | "text";

export type WhiteboardToolType =
  | "hand"
  | "selection"
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image"
  | "eraser"
  | "frame";

export interface WhiteboardAsset {
  readonly id: string;
  readonly dataURL: string;
  readonly mimeType: string;
  readonly created: number;
  readonly revision?: number;
  readonly lastRetrieved?: number;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly width?: number;
  readonly height?: number;
}

export type WhiteboardAssetMimeTypeV2 =
  | "application/octet-stream"
  | "image/avif"
  | "image/bmp"
  | "image/gif"
  | "image/jpeg"
  | "image/jfif"
  | "image/png"
  | "image/svg+xml"
  | "image/vnd.microsoft.icon"
  | "image/webp"
  | "image/x-icon";

interface WhiteboardAssetV2Base {
  readonly id: string;
  readonly mimeType: WhiteboardAssetMimeTypeV2;
  readonly created: number;
  readonly lastRetrieved?: number;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface WhiteboardInlineAssetV2 extends WhiteboardAssetV2Base {
  readonly storage: "inline";
  readonly dataURL: string;
}

export interface WhiteboardExternalAssetV2 extends WhiteboardAssetV2Base {
  readonly storage: "external";
}

export type WhiteboardAssetV2 =
  WhiteboardInlineAssetV2 | WhiteboardExternalAssetV2;

interface WhiteboardElementV2Base {
  readonly id: string;
  readonly isDeleted: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: WhiteboardFillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: WhiteboardStrokeStyle;
  readonly opacity: number;
  readonly roughness: number;
  readonly roundness?: WhiteboardEdgeStyle;
  readonly locked: boolean;
}

export interface WhiteboardBoxElementV2 extends WhiteboardElementV2Base {
  readonly type:
    | "diamond"
    | "ellipse"
    | "embeddable"
    | "frame"
    | "iframe"
    | "magicframe"
    | "rectangle";
}

export interface WhiteboardLinearElementV2 extends WhiteboardElementV2Base {
  readonly type: "arrow" | "freedraw" | "line";
  readonly points: readonly (readonly [number, number])[];
}

export interface WhiteboardImageElementV2 extends WhiteboardElementV2Base {
  readonly type: "image";
  readonly fileId: string | null;
}

export interface WhiteboardTextElementV2 extends WhiteboardElementV2Base {
  readonly type: "text";
  readonly text: string;
  readonly originalText: string;
  readonly fontSize: number;
  readonly lineHeight: number;
}

export type WhiteboardElementV2 =
  | WhiteboardBoxElementV2
  | WhiteboardImageElementV2
  | WhiteboardLinearElementV2
  | WhiteboardTextElementV2;

export interface WhiteboardDocumentMetadataV2 {
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly viewBackgroundColor: string;
  readonly gridSize: number | null;
}

export interface WhiteboardDocumentV2 {
  readonly version: 2;
  readonly elements: readonly WhiteboardElementV2[];
  readonly assets: Readonly<Record<string, WhiteboardAssetV2>>;
  readonly metadata: WhiteboardDocumentMetadataV2;
}

export interface WhiteboardBindingV3 {
  readonly elementId: string;
  readonly focus: number;
  readonly gap: number;
  readonly fixedPoint?: readonly [number, number];
}

export interface WhiteboardImageCropV3 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface WhiteboardAssetV3 {
  readonly id: string;
  readonly mimeType: WhiteboardAssetMimeTypeV2;
  readonly created: number;
  readonly lastRetrieved?: number;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly width?: number;
  readonly height?: number;
  readonly storage: "external" | "inline";
  readonly dataURL?: string;
  readonly revision: number;
}

interface WhiteboardElementV3Base {
  readonly id: string;
  readonly type: WhiteboardElementType;
  readonly index: string;
  readonly isDeleted: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: WhiteboardFillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: WhiteboardStrokeStyle;
  readonly opacity: number;
  readonly roughness: number;
  readonly roundness?: WhiteboardEdgeStyle;
  readonly seed: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly updatedAt: number;
  readonly groupIds: readonly string[];
  readonly frameId: string | null;
  readonly locked: boolean;
}

export interface WhiteboardBoxElementV3 extends WhiteboardElementV3Base {
  readonly type:
    | "diamond"
    | "ellipse"
    | "embeddable"
    | "iframe"
    | "magicframe"
    | "rectangle";
}

export interface WhiteboardFrameElementV3 extends WhiteboardElementV3Base {
  readonly type: "frame";
  readonly name: string;
}

export interface WhiteboardTextElementV3 extends WhiteboardElementV3Base {
  readonly type: "text";
  readonly text: string;
  readonly originalText: string;
  readonly fontFamily: "excalifont" | "nunito" | "system";
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly textAlign: "left" | "center" | "right";
  readonly verticalAlign: "top" | "middle" | "bottom";
  readonly containerId: string | null;
  readonly autoResize: boolean;
}

export interface WhiteboardLinearElementV3 extends WhiteboardElementV3Base {
  readonly type: "arrow" | "line";
  readonly points: readonly (readonly [number, number])[];
  readonly startArrowhead: string | null;
  readonly endArrowhead: string | null;
  readonly startBinding: WhiteboardBindingV3 | null;
  readonly endBinding: WhiteboardBindingV3 | null;
  readonly elbowed: boolean;
  readonly fixedSegments: readonly number[];
}

export interface WhiteboardFreedrawElementV3 extends WhiteboardElementV3Base {
  readonly type: "freedraw";
  readonly points: readonly (readonly [number, number])[];
  readonly pressures: readonly number[];
  readonly simulatePressure: boolean;
  readonly lastCommittedPoint: readonly [number, number] | null;
}

export interface WhiteboardImageElementV3 extends WhiteboardElementV3Base {
  readonly type: "image";
  readonly fileId: string | null;
  readonly status: "pending" | "saved" | "error";
  readonly scale: readonly [number, number];
  readonly crop: WhiteboardImageCropV3 | null;
}

export type WhiteboardElementV3 =
  | WhiteboardBoxElementV3
  | WhiteboardFrameElementV3
  | WhiteboardFreedrawElementV3
  | WhiteboardImageElementV3
  | WhiteboardLinearElementV3
  | WhiteboardTextElementV3;

export type WhiteboardElement = WhiteboardElementV2 | WhiteboardElementV3;

export interface WhiteboardDocumentMetadataV3 {
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly viewBackgroundColor: string;
  readonly gridSize: number | null;
}

export interface WhiteboardDocumentV3 {
  readonly version: 3;
  readonly elements: readonly WhiteboardElementV3[];
  readonly assets: Readonly<Record<string, WhiteboardAssetV3>>;
  readonly metadata: WhiteboardDocumentMetadataV3;
}

export interface WhiteboardViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface WhiteboardTool {
  readonly type: WhiteboardToolType;
  readonly locked?: boolean;
}

export type WhiteboardFillStyle =
  "hachure" | "cross-hatch" | "solid" | "zigzag";

export type WhiteboardStrokeStyle = "solid" | "dashed" | "dotted";
export type WhiteboardEdgeStyle = "sharp" | "round";

export interface WhiteboardElementStyle {
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: WhiteboardFillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: WhiteboardStrokeStyle;
  readonly opacity: number;
  readonly roughness?: number;
  readonly roundness?: WhiteboardEdgeStyle;
}

export type WhiteboardElementStyleUpdate = Partial<WhiteboardElementStyle>;

export type WhiteboardElementOrderAction =
  "back" | "backward" | "forward" | "front";

export interface WhiteboardImportResult {
  readonly name: string | null;
}

/** State persisted by the owned whiteboard document format. */
export interface WhiteboardDocumentState {
  readonly name?: string | null;
  readonly theme?: WhiteboardTheme;
  readonly viewBackgroundColor?: string;
  readonly gridSize?: number | null;
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly zoom?: Readonly<{ value: number }>;
  readonly openDialog?: null;
  readonly openMenu?: null;
  readonly viewModeEnabled?: boolean;
  readonly zenModeEnabled?: boolean;
}

export interface OwnedWhiteboardDocument {
  readonly elements: readonly WhiteboardElement[];
  readonly state: WhiteboardDocumentState;
  readonly assets: Readonly<Record<string, WhiteboardAsset>>;
}

export interface WhiteboardSessionStateV1 {
  readonly version: 1;
  readonly viewport: WhiteboardViewport;
  readonly activeTool: WhiteboardToolType;
  readonly toolLocked: boolean;
  readonly lastUsedStyle: WhiteboardElementStyle;
  readonly openPanel: string | null;
  readonly sceneViewports: Readonly<Record<string, WhiteboardViewport>>;
}

export type OwnedWhiteboardInteraction =
  | "idle"
  | "binding"
  | "drawing"
  | "marquee"
  | "moving"
  | "resizing"
  | "rotating"
  | "text-editing";

export interface OwnedWhiteboardSelectionState {
  readonly elementIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly editingGroupId: string | null;
}

export type WhiteboardMixedValue<T> = T | "mixed";
export interface WhiteboardComputedSelectionStyle {
  readonly strokeColor: WhiteboardMixedValue<string>;
  readonly backgroundColor: WhiteboardMixedValue<string>;
  readonly fillStyle: WhiteboardMixedValue<WhiteboardFillStyle>;
  readonly strokeWidth: WhiteboardMixedValue<number>;
  readonly strokeStyle: WhiteboardMixedValue<WhiteboardStrokeStyle>;
  readonly opacity: WhiteboardMixedValue<number>;
  readonly roughness: WhiteboardMixedValue<number>;
  readonly roundness: WhiteboardMixedValue<WhiteboardEdgeStyle | undefined>;
}

export interface OwnedWhiteboardEditorState {
  readonly activeTool: WhiteboardTool;
  readonly toolLocked: boolean;
  readonly interaction: OwnedWhiteboardInteraction;
  readonly viewport: WhiteboardViewport;
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly selectedElementIds: readonly string[];
  readonly selection: OwnedWhiteboardSelectionState;
  readonly elementStyle: WhiteboardElementStyle;
  readonly selectionStyle: WhiteboardComputedSelectionStyle | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canGroup: boolean;
  readonly canUngroup: boolean;
}

export interface OwnedWhiteboardEditorStateUpdate {
  readonly name?: string;
  readonly theme?: WhiteboardTheme;
  readonly openDialog?: null;
  readonly openMenu?: null;
  readonly contextMenu?: null;
}

export interface WhiteboardImageExportOptions {
  readonly format: "png" | "svg";
  readonly quality?: number;
  readonly exportPadding?: number;
  readonly maxWidthOrHeight?: number;
  readonly scale?: number;
  readonly background?: boolean;
  readonly selectionOnly?: boolean;
  readonly exportWithDarkMode?: boolean;
}

export type WhiteboardUnsubscribe = () => void;

export interface WhiteboardPerformanceSample {
  readonly gesture: "pan" | "zoom" | "draw" | "move" | "resize" | "rotate";
  readonly totalElements: number;
  readonly visibleElements: number;
  readonly frameTimeP50: number;
  readonly frameTimeP95: number;
  readonly frameTimeP99: number;
  readonly inputLatencyP95: number;
  readonly rasterCacheHitRate: number;
  readonly longTaskCount: number;
}

export interface WhiteboardEngine {
  loadDocument(document: OwnedWhiteboardDocument): void;
  getDocument(): OwnedWhiteboardDocument;
  subscribeDocument(
    listener: (document: OwnedWhiteboardDocument) => void,
  ): WhiteboardUnsubscribe;

  getEditorState(): OwnedWhiteboardEditorState;
  subscribeEditorState(
    listener: (state: OwnedWhiteboardEditorState) => void,
  ): WhiteboardUnsubscribe;
  updateEditorState(update: OwnedWhiteboardEditorStateUpdate): void;

  getActiveTool(): WhiteboardTool;
  setActiveTool(tool: WhiteboardTool): void;
  setToolLocked(locked: boolean): void;

  updateElementStyle(update: WhiteboardElementStyleUpdate): void;
  reorderSelection(action: WhiteboardElementOrderAction): void;
  selectAll(): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  groupSelection(): void;
  ungroupSelection(): void;

  getViewport(): WhiteboardViewport;
  updateViewport(
    update: Partial<Pick<WhiteboardViewport, "x" | "y" | "zoom">>,
  ): void;
  fitToContent(options?: {
    readonly animate?: boolean;
    readonly fitToViewport?: boolean;
    readonly viewportZoomFactor?: number;
  }): void;
  zoomToSelection(): void;
  resetZoom(): void;
  cancelInteraction(): void;

  undo(): void;
  redo(): void;
  clearDocument(): void;

  addAssets(assets: readonly WhiteboardAsset[]): void;
  getAssets(): Readonly<Record<string, WhiteboardAsset>>;
  insertImage?(blob: Blob): Promise<void>;

  exportImage(options: WhiteboardImageExportOptions): Promise<Blob>;
  exportDocument(): Promise<Blob>;
  importDocument(blob: Blob): Promise<WhiteboardImportResult>;

  destroy(): void;
}

export interface WhiteboardViewerController {
  getViewport(): WhiteboardViewport;
  subscribeViewport(
    listener: (viewport: WhiteboardViewport) => void,
  ): WhiteboardUnsubscribe;
  updateViewport(
    update: Partial<Pick<WhiteboardViewport, "x" | "y" | "zoom">>,
  ): void;
  fitToContent(options?: {
    readonly fitToViewport?: boolean;
    readonly viewportZoomFactor?: number;
  }): void;
}
