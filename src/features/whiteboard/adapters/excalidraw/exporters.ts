import { exportToSvg, MIME_TYPES } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  WhiteboardDocument,
  WhiteboardImageExportOptions,
} from "@/features/whiteboard";
import {
  toExcalidrawAppState,
  toExcalidrawElements,
  toExcalidrawFiles,
} from "./conversions";
import {
  createExcalidrawSceneData,
  exportSceneToPngBlob,
} from "@/lib/excalidraw";
import { createJsonBlob } from "@/lib/download";

type ExportToSvg = (options: {
  elements: readonly NonDeletedExcalidrawElement[];
  appState?: Partial<Omit<AppState, "offsetTop" | "offsetLeft">>;
  files: BinaryFiles | null;
  exportPadding?: number;
}) => Promise<SVGSVGElement>;

function getVisibleElements(
  document: WhiteboardDocument,
): readonly NonDeletedExcalidrawElement[] {
  return (
    toExcalidrawElements(document.elements) as readonly ExcalidrawElement[]
  ).filter(
    (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
  );
}

export async function exportExcalidrawImage(
  document: WhiteboardDocument,
  options: WhiteboardImageExportOptions,
): Promise<Blob> {
  const appState = toExcalidrawAppState(document.state);
  const exportAppState = {
    ...appState,
    exportWithDarkMode: appState.theme === "dark",
    exportBackground: true,
  };
  const elements = getVisibleElements(document);
  const files = toExcalidrawFiles(document.assets);

  if (options.format === "svg") {
    const exportSvg = exportToSvg as unknown as ExportToSvg;
    const svg = await exportSvg({
      elements,
      appState: exportAppState,
      files,
      exportPadding: options.exportPadding,
    });
    return new Blob([svg.outerHTML], { type: MIME_TYPES.svg });
  }

  return await exportSceneToPngBlob(elements, exportAppState, files, {
    quality: options.quality,
    exportPadding: options.exportPadding,
    maxWidthOrHeight: options.maxWidthOrHeight,
  });
}

export async function exportExcalidrawDocument(
  document: WhiteboardDocument,
): Promise<Blob> {
  const sceneData = createExcalidrawSceneData(
    getVisibleElements(document),
    toExcalidrawAppState(document.state),
    toExcalidrawFiles(document.assets),
  );
  return createJsonBlob(sceneData);
}
