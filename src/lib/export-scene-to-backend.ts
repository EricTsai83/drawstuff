import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import { clearElementsForDatabase } from "@/lib/whiteboard";
import { extractImageFiles, processFilesForUpload } from "./file-processor";
import type {
  WhiteboardAsset,
  WhiteboardDocumentState,
  WhiteboardElement,
} from "@/features/whiteboard";
import {
  createPersistedWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  WHITEBOARD_DOCUMENT_VERSION,
} from "@/features/whiteboard";

// 準備場景數據用於導出
export async function prepareSceneDataForExport(
  elements: readonly WhiteboardElement[],
  appState: WhiteboardDocumentState,
  files: Readonly<Record<string, WhiteboardAsset>>,
  options?: {
    readonly encrypt?: boolean;
    readonly includeInlineAssets?: boolean;
  },
) {
  const shouldEncrypt = options?.encrypt ?? true;
  const encryptionKey = shouldEncrypt
    ? await generateEncryptionKey("string")
    : null;

  // 場景資料：壓縮，視需要加密
  const compressedSceneData = await compressData(
    new TextEncoder().encode(
      serializeSceneData(elements, appState, files, {
        includeInlineAssets: options?.includeInlineAssets,
      }),
    ),
    { encryptionKey },
  );

  // 檔案資料：永遠壓縮，根據選項加/不加密
  const imageFilesMap = extractImageFiles(elements, files);
  const compressedFilesData = await processFilesForUpload({
    files: imageFilesMap,
    encryptionKey,
    maxBytes: FILE_UPLOAD_MAX_BYTES,
  });

  return {
    compressedSceneData,
    compressedFilesData,
    encryptionKey: (encryptionKey ?? undefined) as unknown as string,
    documentVersion: WHITEBOARD_DOCUMENT_VERSION,
  } as const;
}

function serializeSceneData(
  elements: readonly WhiteboardElement[],
  appState: WhiteboardDocumentState,
  files: Readonly<Record<string, WhiteboardAsset>>,
  options?: {
    readonly includeInlineAssets?: boolean;
  },
): string {
  const persistedElements = clearElementsForDatabase(elements);
  return serializeWhiteboardDocumentV2(
    createPersistedWhiteboardDocumentV2(
      {
        elements: persistedElements,
        assets: files,
        state: appState,
      },
      {
        assetStorage:
          options?.includeInlineAssets === false ? "external" : "inline",
      },
    ),
  );
}
