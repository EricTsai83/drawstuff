import type {
  FileId,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import {
  isInitializedImageElement,
  clearElementsForDatabase,
} from "@/lib/excalidraw";
import { handleSceneSave } from "@/server/actions";

// 主函數：組合瀏覽器端處理並直接發送到伺服器
export async function handleSceneExport(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) {
  const { compressedSceneData, filesToUpload, encryptionKey } =
    await prepareSceneData(elements, appState, files);

  try {
    // 直接使用 server action
    const result = await handleSceneSave(
      compressedSceneData,
      filesToUpload,
      encryptionKey,
    );

    return result as { url: string | null; errorMessage: string | null };
  } catch (error: unknown) {
    console.error(error);
    return {
      url: null,
      errorMessage: "Could not create shareable link",
    };
  }
}

// 瀏覽器端處理：準備數據和加密
export async function prepareSceneData(
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

  // 準備文件數據
  const imageFilesMap = new Map<FileId, BinaryFileData>();
  for (const element of elements) {
    if (isInitializedImageElement(element) && files[element.fileId]) {
      // Record 類型的屬性訪問總是返回 T | undefined，即
      // 使我們在邏輯上已經確保了該屬性存在。最簡潔的解決方案就是使用非空斷言操作符 "!"
      imageFilesMap.set(element.fileId, files[element.fileId]!);
    }
  }

  const filesToUpload = await processFilesForUpload({
    files: imageFilesMap,
    encryptionKey,
    maxBytes: FILE_UPLOAD_MAX_BYTES,
  });

  return {
    compressedSceneData,
    filesToUpload,
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

async function processFilesForUpload({
  files,
  maxBytes,
  encryptionKey,
}: {
  files: Map<FileId, BinaryFileData>;
  maxBytes: number;
  encryptionKey: string;
}) {
  const encodedFiles: {
    id: FileId;
    buffer: Uint8Array;
  }[] = [];

  for (const [id, fileData] of files) {
    const buffer = new TextEncoder().encode(fileData.dataURL);

    const encodedFile = await compressData<BinaryFileMetadata>(buffer, {
      encryptionKey,
      metadata: {
        id,
        mimeType: fileData.mimeType,
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    });

    if (buffer.byteLength > maxBytes) {
      throw new Error(`File too big: ${Math.trunc(maxBytes / 1024 / 1024)}MB`);
    }

    encodedFiles.push({
      id,
      buffer: encodedFile,
    });
  }

  return encodedFiles;
}
