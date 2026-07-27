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

export interface WhiteboardElement {
  readonly id: string;
  readonly type: string;
  readonly isDeleted: boolean;
  readonly fileId?: string | null;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly angle?: number;
  readonly points?: readonly (readonly [number, number])[];
  readonly text?: string;
  readonly originalText?: string;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
  readonly fillStyle?: WhiteboardFillStyle;
  readonly strokeWidth?: number;
  readonly strokeStyle?: WhiteboardStrokeStyle;
  readonly opacity?: number;
  readonly roughness?: number;
  readonly seed?: number;
  readonly locked?: boolean;
  readonly hidden?: boolean;
  readonly visible?: boolean;
  readonly lastCommittedPoint?: readonly [number, number] | null;
}

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

export type WhiteboardJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly WhiteboardJsonValue[]
  | { readonly [key: string]: WhiteboardJsonValue };

export interface WhiteboardLegacyEnvelope {
  readonly format: "excalidraw";
  readonly sourceVersion: number | null;
  readonly migrationVersion: 1;
  readonly originalPayload: string;
  readonly unsupported: Readonly<Record<string, WhiteboardJsonValue>>;
}

export interface WhiteboardDocumentMetadata {
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly viewBackgroundColor: string;
  readonly gridSize: number | null;
  readonly viewport?: {
    readonly scrollX: number;
    readonly scrollY: number;
    readonly zoom: number;
  };
  readonly legacy?: WhiteboardLegacyEnvelope;
}

export interface WhiteboardDocumentV1 {
  readonly version: 1;
  readonly elements: readonly WhiteboardElement[];
  readonly assets: Readonly<Record<string, WhiteboardAsset>>;
  readonly metadata: WhiteboardDocumentMetadata;
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

export type WhiteboardPersistenceFormat =
  "legacy-excalidraw" | "whiteboard-v1" | "whiteboard-v2";

export interface WhiteboardDocumentPersistence {
  readonly sourceFormat: WhiteboardPersistenceFormat;
  readonly documentVersion: number | null;
  readonly legacyRollback?: WhiteboardLegacyEnvelope;
  readonly migratedFromLegacy?: boolean;
  readonly loadedFromRecovery?: boolean;
  readonly convertedFrom?: Exclude<
    WhiteboardPersistenceFormat,
    "whiteboard-v2"
  >;
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

export interface WhiteboardElementStyle {
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: WhiteboardFillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: WhiteboardStrokeStyle;
  readonly opacity: number;
  readonly roughness?: number;
}

export type WhiteboardElementStyleUpdate = Partial<WhiteboardElementStyle>;

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
  readonly openDialog?: unknown;
  readonly openMenu?: unknown;
  readonly viewModeEnabled?: boolean;
  readonly zenModeEnabled?: boolean;
}

export interface WhiteboardDocument {
  readonly elements: readonly WhiteboardElement[];
  readonly state: WhiteboardDocumentState;
  readonly assets: Readonly<Record<string, WhiteboardAsset>>;
  /**
   * Persistence-only provenance. Engines carry this through edits so an owned
   * write can retain the pre-migration payload without exposing scene content
   * to operational diagnostics.
   */
  readonly persistence?: WhiteboardDocumentPersistence;
}

export interface WhiteboardEditorState {
  readonly activeTool: WhiteboardTool;
  readonly viewport: WhiteboardViewport;
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly selectedElementIds: readonly string[];
  readonly elementStyle: WhiteboardElementStyle;
}

export interface WhiteboardEditorStateUpdate {
  readonly name?: string;
  readonly theme?: WhiteboardTheme;
  readonly openDialog?: unknown;
  readonly openMenu?: unknown;
  readonly contextMenu?: unknown;
}

export interface WhiteboardImageExportOptions {
  readonly format: "png" | "svg";
  readonly quality?: number;
  readonly exportPadding?: number;
  readonly maxWidthOrHeight?: number;
  readonly scale?: number;
  readonly background?: boolean;
  readonly selectionOnly?: boolean;
}

export type WhiteboardUnsubscribe = () => void;

export interface WhiteboardEngine {
  loadDocument(document: WhiteboardDocument): void;
  getDocument(): WhiteboardDocument;
  subscribeDocument(
    listener: (document: WhiteboardDocument) => void,
  ): WhiteboardUnsubscribe;

  getEditorState(): WhiteboardEditorState;
  subscribeEditorState(
    listener: (state: WhiteboardEditorState) => void,
  ): WhiteboardUnsubscribe;
  updateEditorState(update: WhiteboardEditorStateUpdate): void;

  getActiveTool(): WhiteboardTool;
  setActiveTool(tool: WhiteboardTool): void;

  updateElementStyle(update: WhiteboardElementStyleUpdate): void;

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
