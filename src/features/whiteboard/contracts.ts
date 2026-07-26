export type WhiteboardTheme = "light" | "dark";

export interface WhiteboardElement {
  readonly id: string;
  readonly type: string;
  readonly isDeleted: boolean;
  readonly fileId?: string | null;
}

export interface WhiteboardAsset {
  readonly id: string;
  readonly dataURL: string;
  readonly mimeType: string;
  readonly created: number;
  readonly lastRetrieved?: number;
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

/**
 * The scene state remains an engine-native legacy payload in Phase 5A.
 * These shared fields let product code use it without defining the owned
 * persisted document format planned for Phase 5B.
 */
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
}

export interface WhiteboardEditorState {
  readonly activeTool: WhiteboardTool;
  readonly viewport: WhiteboardViewport;
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly selectedElementIds: readonly string[];
}

export interface WhiteboardEditorStateUpdate {
  readonly name?: string;
  readonly theme?: WhiteboardTheme;
  readonly openDialog?: unknown;
  readonly openMenu?: unknown;
}

export interface WhiteboardImageExportOptions {
  readonly format: "png" | "svg";
  readonly quality?: number;
  readonly exportPadding?: number;
  readonly maxWidthOrHeight?: number;
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

  addAssets(assets: readonly WhiteboardAsset[]): void;
  getAssets(): Readonly<Record<string, WhiteboardAsset>>;

  exportImage(options: WhiteboardImageExportOptions): Promise<Blob>;
  exportDocument(): Promise<Blob>;

  destroy(): void;
}
