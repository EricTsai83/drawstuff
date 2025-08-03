import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import { clearElementsForDatabase } from "@/lib/excalidraw";
import { extractImageFiles, processFilesForUpload } from "./file-processor";

// 準備場景數據用於導出
export async function prepareSceneDataForExport(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) {
  const encryptionKey = await generateEncryptionKey("string");

  // 準備場景數據
  const compressedSceneData = await compressData(
    new TextEncoder().encode(serializeSceneData(elements, appState)),
    { encryptionKey },
  );

  // 提取並處理圖片文件
  const imageFilesMap = extractImageFiles(elements, files);

  const compressedFilesData = await processFilesForUpload({
    files: imageFilesMap,
    encryptionKey,
    maxBytes: FILE_UPLOAD_MAX_BYTES,
  });

  return {
    compressedSceneData,
    compressedFilesData,
    encryptionKey,
  };
}

function serializeSceneData(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
): string {
  const data = {
    elements: clearElementsForDatabase(elements),
    appState,
  };

  return JSON.stringify(data, null, 2);
}
