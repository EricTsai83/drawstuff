import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  WhiteboardAsset,
  WhiteboardDocument,
  WhiteboardDocumentState,
  WhiteboardElement,
  WhiteboardTool,
} from "@/features/whiteboard";

export function toWhiteboardDocument(
  elements: readonly ExcalidrawElement[],
  appState: AppState | Partial<AppState>,
  files: BinaryFiles,
): WhiteboardDocument {
  return {
    elements,
    state: appState,
    assets: files,
  };
}

export function toExcalidrawElements(
  elements: readonly WhiteboardElement[],
): readonly OrderedExcalidrawElement[] {
  return elements as unknown as readonly OrderedExcalidrawElement[];
}

export function toExcalidrawAppState(
  state: WhiteboardDocumentState,
): Partial<AppState> {
  return state as unknown as Partial<AppState>;
}

export function toExcalidrawFiles(
  assets: Readonly<Record<string, WhiteboardAsset>>,
): BinaryFiles {
  return assets as unknown as BinaryFiles;
}

export function toExcalidrawAssets(
  assets: readonly WhiteboardAsset[],
): BinaryFileData[] {
  return assets as unknown as BinaryFileData[];
}

export function toExcalidrawInitialData(
  document: WhiteboardInitialData,
): ExcalidrawInitialDataState {
  return {
    elements: toExcalidrawElements(document.elements),
    appState: toExcalidrawAppState(document.state),
    files: toExcalidrawFiles(document.assets),
    scrollToContent: document.scrollToContent,
  };
}

export function toExcalidrawTool(tool: WhiteboardTool): AppState["activeTool"] {
  return tool as unknown as AppState["activeTool"];
}

export type WhiteboardInitialData = WhiteboardDocument & {
  readonly scrollToContent?: boolean;
};
