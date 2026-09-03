import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";
import type {
  AppState,
  BinaryFiles,
} from "@drawstuff/excalidraw-adapter/types";
import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import { extractImageFiles, processFilesForUpload } from "./file-processor";
import {
  createOwnedSceneDocumentV4,
  createReadonlyShareDocumentV4,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";
import type { ExcalidrawStorageProfile } from "@drawstuff/excalidraw-adapter/codec";

type BackendSceneStorageProfile = Extract<
  ExcalidrawStorageProfile,
  "owned-scene" | "readonly-share"
>;

// 準備場景數據用於導出
export async function prepareSceneDataForExport(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  options?: {
    encrypt?: boolean;
    profile?: BackendSceneStorageProfile;
  },
) {
  const shouldEncrypt = options?.encrypt ?? true;
  const profile = options?.profile ?? "owned-scene";

  const encryptionKey = shouldEncrypt
    ? await generateEncryptionKey("string")
    : null;

  // 場景資料：壓縮，視需要加密
  const compressedSceneData = await compressData(
    new TextEncoder().encode(
      serializeSceneData(elements, appState, files, profile),
    ),
    { encryptionKey },
  );

  // 檔案資料：永遠壓縮，根據選項加/不加密
  const imageFilesMap = extractImageFiles(
    elements.filter(
      (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
    ),
    files,
  );
  const compressedFilesData = await processFilesForUpload({
    files: imageFilesMap,
    encryptionKey,
    maxBytes: FILE_UPLOAD_MAX_BYTES,
  });

  return {
    compressedSceneData,
    compressedFilesData,
    /** `null` when `options.encrypt` is false. */
    encryptionKey,
  } as const;
}

export function serializeSceneData(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles = {},
  profile: BackendSceneStorageProfile = "owned-scene",
): string {
  const createDocument =
    profile === "readonly-share"
      ? createReadonlyShareDocumentV4
      : createOwnedSceneDocumentV4;
  return serializeDrawstuffDocumentV4(
    createDocument({
      elements,
      appState,
      files,
      name: appState.name ?? undefined,
    }),
  );
}
