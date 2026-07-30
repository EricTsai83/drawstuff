import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import type { OrderedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import {
  importFromLocalStorage,
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneDirtyToStorage,
  saveCurrentSceneIdToStorage,
  saveCurrentSceneRevisionToStorage,
  clearCurrentSceneRevisionFromStorage,
  clearCurrentSceneSessionFromStorage,
} from "@/data/local-storage";
import { STORAGE_KEYS } from "@/config/app-constants";
import type {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  ExcalidrawFrameLikeElement,
} from "@drawstuff/excalidraw-adapter/types";
import { loadScene, openConfirmModal } from "@/lib/initialize-scene";
import { createJsonBlob, triggerBlobDownload } from "@/lib/download";
import { parseSharedSceneHash } from "@/lib/utils";
import {
  EXCALIDRAW_MIME_TYPES,
  exportCanvasToBlob,
} from "@drawstuff/excalidraw-adapter/client";
import { ensureInitialAppState } from "@drawstuff/excalidraw-adapter/codec";
import { createLocalExportDocument } from "@drawstuff/excalidraw-adapter/codec";
import { getBaseUrl } from "@/lib/base-url";

// excalidraw 初始化的數據要求是 Promise，所以需要這個函數來創建
export async function createInitialDataPromise(): Promise<ExcalidrawInitialDataState | null> {
  try {
    const localDataState = importFromLocalStorage();

    // 先檢查 URL hash 是否包含外部場景連結
    const jsonBackendMatch = parseSharedSceneHash();

    const hasLocalSavedScene =
      localDataState.elements.length > 0 ||
      !!localDataState.appState ||
      Object.keys(localDataState.files).length > 0;

    if (jsonBackendMatch) {
      // 若本地有資料，提示是否覆蓋
      const shareableLinkConfirmDialog = {
        title: "載入分享連結內容？",
        description: "此操作將覆蓋目前畫布內容。",
        actionLabel: "覆蓋並載入",
      };

      try {
        if (hasLocalSavedScene) {
          const ok = await openConfirmModal(shareableLinkConfirmDialog);
          if (!ok) {
            window.history.replaceState(
              {},
              document.title,
              window.location.origin,
            );
            return await restoreInitialDataFromLocal(
              localDataState,
              hasLocalSavedScene,
            );
          }
        }

        const scene = await loadScene(
          jsonBackendMatch.id,
          jsonBackendMatch.key,
          localDataState,
        );

        // 清除加密資訊，避免資訊殘留在 URL 上
        window.history.replaceState({}, document.title, window.location.origin);

        return {
          elements: scene.elements ?? [],
          appState: {
            ...ensureInitialAppState(scene.appState ?? {}),
          },
          files: scene.files ?? {},
          scrollToContent: true,
        };
      } catch (e) {
        console.error("透過 URL 載入場景失敗，回退至本地資料:", e);
        return await restoreInitialDataFromLocal(
          localDataState,
          hasLocalSavedScene,
        );
      }
    }

    if (hasLocalSavedScene) {
      return await restoreInitialDataFromLocal(
        localDataState,
        hasLocalSavedScene,
      );
    }

    return await loadInitialRemoteScene();
  } catch (error) {
    console.error("初始化場景失敗:", error);
    return null;
  }
}

async function restoreInitialDataFromLocal(
  localDataState: ReturnType<typeof importFromLocalStorage>,
  hasLocalSavedScene: boolean,
): Promise<ExcalidrawInitialDataState | null> {
  if (!hasLocalSavedScene) {
    return null;
  }

  try {
    const restored = await loadScene(undefined, undefined, localDataState);
    const appState = ensureInitialAppState(restored.appState ?? {});
    return {
      elements: restored.elements ?? [],
      appState,
      files: restored.files ?? {},
      scrollToContent: !hasViewportData(appState),
    };
  } catch {
    const appState = ensureInitialAppState(localDataState.appState ?? {});
    return {
      elements: localDataState.elements ?? [],
      appState,
      files: localDataState.files ?? {},
      scrollToContent: !hasViewportData(appState),
    };
  }
}

async function loadInitialRemoteScene(): Promise<ExcalidrawInitialDataState | null> {
  const sceneId = loadCurrentSceneIdFromStorage();
  if (!sceneId) {
    return null;
  }

  try {
    const { importSceneDataBySceneId, importSceneFilesBySceneId } =
      await import("@/lib/import-data-from-db");
    const imported = await importSceneDataBySceneId(sceneId);
    const files = await importSceneFilesBySceneId(sceneId);
    const appState = ensureInitialAppState(imported.appState ?? {});
    const elements = imported.elements;

    if (!Array.isArray(elements)) {
      try {
        clearCurrentSceneSessionFromStorage();
      } catch {
        // ignore storage errors
      }
      return null;
    }

    const filesComplete = hasCompleteSceneFileHydration(elements, files);
    if (filesComplete) {
      saveToLocalStorage(elements, appState, files);
    }
    saveCurrentSceneIdToStorage(sceneId);
    saveCurrentSceneDirtyToStorage(false);
    const importedRevisionValue: unknown = imported.revision;
    const importedRevision =
      typeof importedRevisionValue === "number"
        ? importedRevisionValue
        : undefined;
    if (importedRevision !== undefined) {
      saveCurrentSceneRevisionToStorage(importedRevision);
    } else {
      clearCurrentSceneRevisionFromStorage();
    }

    return {
      elements,
      appState,
      files,
      scrollToContent: !hasViewportData(appState),
    };
  } catch (error) {
    console.error("初始化遠端場景失敗:", error);
    // Clear persisted session markers so the app doesn't remain attached
    // to a dead remote scene on next load.
    try {
      clearCurrentSceneSessionFromStorage();
    } catch {
      // ignore storage errors
    }
    return null;
  }
}

export function saveData(data: {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}) {
  const timestamp = Date.now();

  try {
    // 永遠以「非刪除元素」作為依據，過濾未被使用或僅被暫刪元素引用的檔案
    const cleanedFiles = cleanUnusedFiles(data.elements, data.files);

    // 使用 saveToLocalStorage 函數儲存數據（避免暫刪元素引用的檔案殘留）
    saveToLocalStorage(data.elements, data.appState, cleanedFiles);

    // 更新版本時間戳
    localStorage.setItem(STORAGE_KEYS.VERSION_DATA_STATE, timestamp.toString());
    localStorage.setItem(STORAGE_KEYS.VERSION_FILES, timestamp.toString());
  } catch (error) {
    console.error("保存數據失敗:", error);
  }
}

// 清理未被元素引用的 files
export function cleanUnusedFiles(
  elements: readonly OrderedExcalidrawElement[],
  files: BinaryFiles,
): BinaryFiles {
  if (elements === null || elements.length === 0 || !files) {
    return {};
  }

  const fileIdsInFiles = Object.keys(files);
  // 僅考慮非刪除元素，確保暫刪元素不會讓其引用的檔案被儲存
  const nonDeletedElements = getNonDeletedElements(elements);
  const fileIdsInElements = new Set<string>();

  nonDeletedElements.forEach((element) => {
    if ("fileId" in element && element.fileId) {
      fileIdsInElements.add(element.fileId);
    }
  });

  const filteredFiles: BinaryFiles = {};
  fileIdsInElements.forEach((fileId) => {
    if (files[fileId]) {
      filteredFiles[fileId] = files[fileId];
    }
  });

  const cleanedCount =
    fileIdsInFiles.length - Object.keys(filteredFiles).length;
  if (cleanedCount > 0) {
    console.log(`beforeunload: 清理了 ${cleanedCount} 個未使用的文件`);
  }

  return filteredFiles;
}

function getReferencedFileIds(
  elements: readonly ExcalidrawElement[] | null | undefined,
): Set<string> {
  const fileIds = new Set<string>();
  if (!Array.isArray(elements)) {
    return fileIds;
  }

  elements.forEach((element: ExcalidrawElement) => {
    if (element.isDeleted) {
      return;
    }
    if (isInitializedImageElement(element)) {
      fileIds.add(element.fileId);
    }
  });

  return fileIds;
}

export function hasCompleteSceneFileHydration(
  elements: readonly ExcalidrawElement[] | null | undefined,
  files: BinaryFiles | null | undefined,
): boolean {
  const referencedFileIds = getReferencedFileIds(elements);
  if (referencedFileIds.size === 0) {
    return true;
  }
  if (!files) {
    return false;
  }

  return [...referencedFileIds].every((fileId) => Boolean(files[fileId]));
}

// 將 excalidraw 狀態存入 localStorage
export function saveToLocalStorage(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) {
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify(elements),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(appState),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_FILES,
      JSON.stringify(files),
    );
  } catch (error) {
    console.error("beforeunload 儲存數據失敗:", error);
  }
}

const getNonDeletedElements = <T extends ExcalidrawElement>(
  elements: readonly T[],
) =>
  elements.filter((element) => !element.isDeleted) as readonly NonDeleted<T>[];

export function isInitializedImageElement(
  element: ExcalidrawElement | null,
): element is InitializedExcalidrawImageElement {
  return !!element && element.type === "image" && !!element.fileId;
}

// 以標準格式將場景儲存為 .excalidraw 並下載
export function saveSceneJsonToDisk(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  fileName?: string,
): void {
  const sceneData = createLocalExportDocument({
    elements,
    appState,
    files,
    source: getBaseUrl(),
  });
  const blob = createJsonBlob(sceneData);
  const baseName =
    ((appState.name as string | undefined) ?? "scene").trim() || "scene";
  triggerBlobDownload(`${fileName ?? baseName}.excalidraw`, blob);
}

// 關閉 Excalidraw 內建對話框（如 Export 對話框）
export function closeExcalidrawDialog(
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
): void {
  if (!excalidrawAPI) return;
  const currentAppState = excalidrawAPI.getAppState();
  if (!currentAppState) return;
  excalidrawAPI.updateScene({
    appState: {
      ...currentAppState,
      openDialog: null,
    },
  });
}

// 從 API 取目前場景 snapshot
export function getCurrentSceneSnapshot(
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
): {
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
} | null {
  if (!excalidrawAPI) return null;
  // Cloud/share persistence needs collaboration tombstones as well as visible
  // elements. Disk export still receives Excalidraw's non-deleted callback
  // elements through its separate handler.
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
  const appState = excalidrawAPI.getAppState();
  const files = excalidrawAPI.getFiles();
  return { elements, appState: appState as Partial<AppState>, files };
}

/** Whether the appState contains saved viewport position (scrollX/scrollY/zoom). */
function hasViewportData(appState: Partial<AppState>): boolean {
  return (
    typeof appState.scrollX === "number" ||
    typeof appState.scrollY === "number" ||
    appState.zoom !== undefined
  );
}

// 匯出場景為 PNG Blob（抽共用）
export async function exportSceneToPngBlob(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  options?: {
    quality?: number;
    exportPadding?: number;
    maxWidthOrHeight?: number;
    getDimensions?: (
      width: number,
      height: number,
    ) => {
      width: number;
      height: number;
      scale?: number;
    };
  },
): Promise<Blob> {
  const elementsForExport = getNonDeletedElements(
    elements as readonly ExcalidrawElement[],
  );

  // Ensure export respects current theme and includes background by default
  const appStateForExport: Partial<AppState> = {
    ...appState,
    exportWithDarkMode: appState.theme === "dark",
    exportBackground: true,
  };

  type ExportToBlobFn = (opts: {
    elements: readonly NonDeletedExcalidrawElement[];
    appState?: Partial<Omit<AppState, "offsetTop" | "offsetLeft">>;
    files: BinaryFiles | null;
    maxWidthOrHeight?: number;
    exportingFrame?: ExcalidrawFrameLikeElement | null;
    getDimensions?: (
      width: number,
      height: number,
    ) => { width: number; height: number; scale?: number };
    mimeType?: string;
    quality?: number;
    exportPadding?: number;
  }) => Promise<Blob>;

  const exportToBlobTyped: ExportToBlobFn =
    exportCanvasToBlob as unknown as ExportToBlobFn;

  return await exportToBlobTyped({
    elements: elementsForExport,
    appState: appStateForExport,
    files,
    mimeType: EXCALIDRAW_MIME_TYPES.png,
    quality: options?.quality ?? 1,
    exportPadding: options?.exportPadding,
    maxWidthOrHeight: options?.maxWidthOrHeight,
    getDimensions: options?.getDimensions,
  });
}

// 產生用於列表或預覽的縮圖（預設最大邊 800px，含適度邊距）
export async function exportSceneThumbnail(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  opts?: { maxSize?: number; padding?: number; quality?: number },
): Promise<Blob> {
  const maxSize = opts?.maxSize ?? 800;
  const padding = opts?.padding ?? 12;
  const quality = opts?.quality ?? 1;

  return await exportSceneToPngBlob(elements, appState, files, {
    maxWidthOrHeight: maxSize,
    exportPadding: padding,
    quality,
  });
}
