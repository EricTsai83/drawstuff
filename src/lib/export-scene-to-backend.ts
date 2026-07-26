import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import { clearElementsForDatabase } from "@/lib/excalidraw";
import { extractImageFiles, processFilesForUpload } from "./file-processor";
import type {
  WhiteboardAsset,
  WhiteboardDocumentState,
  WhiteboardElement,
} from "@/features/whiteboard";

// 準備場景數據用於導出
export async function prepareSceneDataForExport(
  elements: readonly WhiteboardElement[],
  appState: WhiteboardDocumentState,
  files: Readonly<Record<string, WhiteboardAsset>>,
  options?: { encrypt?: boolean },
) {
  const shouldEncrypt = options?.encrypt ?? true;

  const encryptionKey = shouldEncrypt
    ? await generateEncryptionKey("string")
    : null;

  // 場景資料：壓縮，視需要加密
  const compressedSceneData = await compressData(
    new TextEncoder().encode(serializeSceneData(elements, appState)),
    { encryptionKey },
  );

  // 檔案資料：永遠壓縮，根據選項加/不加密
  const imageFilesMap = extractImageFiles(
    elements as unknown as readonly NonDeletedExcalidrawElement[],
    files as unknown as BinaryFiles,
  );
  const compressedFilesData = await processFilesForUpload({
    files: imageFilesMap,
    encryptionKey,
    maxBytes: FILE_UPLOAD_MAX_BYTES,
  });

  return {
    compressedSceneData,
    compressedFilesData,
    encryptionKey: (encryptionKey ?? undefined) as unknown as string,
  } as const;
}

function serializeSceneData(
  elements: readonly WhiteboardElement[],
  appState: WhiteboardDocumentState,
): string {
  const data = {
    elements: clearElementsForDatabase(
      elements as unknown as readonly NonDeletedExcalidrawElement[],
    ),
    appState,
  };

  return JSON.stringify(data, null, 2);
}
