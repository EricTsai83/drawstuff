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

export interface WhiteboardAsset {
  readonly id: string;
  readonly dataURL: string;
  readonly mimeType: string;
  readonly created: number;
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

export type WhiteboardElement = WhiteboardElementV2;

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
  readonly type: string;
  readonly locked?: boolean;
  readonly customType?: string | null;
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

export interface OwnedWhiteboardEditorState {
  readonly activeTool: WhiteboardTool;
  readonly viewport: WhiteboardViewport;
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly selectedElementIds: readonly string[];
  readonly elementStyle: WhiteboardElementStyle;
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

  updateElementStyle(update: WhiteboardElementStyleUpdate): void;
  reorderSelection?(action: WhiteboardElementOrderAction): void;

  getViewport(): WhiteboardViewport;
  updateViewport(
    update: Partial<Pick<WhiteboardViewport, "x" | "y" | "zoom">>,
  ): void;
  fitToContent(options?: {
    readonly animate?: boolean;
    readonly fitToViewport?: boolean;
    readonly viewportZoomFactor?: number;
  }): void;

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
