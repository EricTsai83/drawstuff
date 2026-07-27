import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import { clearElementsForDatabase } from "@/lib/whiteboard";
import { extractImageFiles, processFilesForUpload } from "./file-processor";
import type {
  WhiteboardAsset,
  WhiteboardDocumentPersistence,
  WhiteboardDocumentState,
  WhiteboardElement,
} from "@/features/whiteboard";
import {
  createPersistedWhiteboardDocumentV1,
  serializeWhiteboardDocumentV1,
} from "@/features/whiteboard";

// 準備場景數據用於導出
export async function prepareSceneDataForExport(
  elements: readonly WhiteboardElement[],
  appState: WhiteboardDocumentState,
  files: Readonly<Record<string, WhiteboardAsset>>,
  options?: {
    readonly encrypt?: boolean;
    readonly persistence?: WhiteboardDocumentPersistence;
    readonly includeInlineAssets?: boolean;
    readonly retainLegacy?: boolean;
    readonly compactLegacyAssets?: boolean;
    readonly assetUploadElements?: readonly WhiteboardElement[];
    readonly assetUploadAssets?: Readonly<Record<string, WhiteboardAsset>>;
    readonly includeDeletedAssetUploads?: boolean;
  },
) {
  const shouldEncrypt = options?.encrypt ?? true;
  const encryptionKey = shouldEncrypt
    ? await generateEncryptionKey("string")
    : null;

  // 場景資料：壓縮，視需要加密
  const compressedSceneData = await compressData(
    new TextEncoder().encode(
      serializeSceneData(elements, appState, files, options?.persistence, {
        includeInlineAssets: options?.includeInlineAssets,
        retainLegacy: options?.retainLegacy,
        compactLegacyAssets: options?.compactLegacyAssets,
      }),
    ),
    { encryptionKey },
  );

  // 檔案資料：永遠壓縮，根據選項加/不加密
  const imageFilesMap = extractImageFiles(
    options?.assetUploadElements ?? elements,
    options?.assetUploadAssets ?? files,
    { includeDeleted: options?.includeDeletedAssetUploads },
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
  files: Readonly<Record<string, WhiteboardAsset>>,
  persistence?: WhiteboardDocumentPersistence,
  options?: {
    readonly includeInlineAssets?: boolean;
    readonly retainLegacy?: boolean;
    readonly compactLegacyAssets?: boolean;
  },
): string {
  const persistedElements = clearElementsForDatabase(elements);
  return serializeWhiteboardDocumentV1(
    createPersistedWhiteboardDocumentV1(
      {
        elements: persistedElements,
        assets: files,
        state: appState,
        persistence,
      },
      options,
    ),
    { allowMissingAssets: options?.includeInlineAssets === false },
  );
}
