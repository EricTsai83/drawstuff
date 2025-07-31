import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  ElementOrToolType,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { importFromLocalStorage } from "@/data/local-storage";
import { STORAGE_KEYS } from "@/config/app-constants";
import type {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/excalidraw/element/types";

// excalidraw 初始化的數據要求是 Promise，所以需要這個函數來創建
export function createInitialDataPromise(): Promise<ExcalidrawInitialDataState | null> {
  return new Promise((resolve) => {
    try {
      const localDataState = importFromLocalStorage();

      if (
        localDataState.elements.length > 0 ||
        localDataState.appState ||
        Object.keys(localDataState.files).length > 0
      ) {
        resolve({
          elements: localDataState.elements ?? [],
          appState: localDataState.appState ?? {},
          files: localDataState.files ?? {},
        });
      } else {
        resolve(null);
      }
    } catch (error) {
      console.error("初始化場景失敗:", error);
      resolve(null);
    }
  });
}

export function saveData(data: {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}) {
  const timestamp = Date.now();

  try {
    // 檢查 version-files 時間是否小於現在時間 10 天
    const versionFilesStr = localStorage.getItem(STORAGE_KEYS.VERSION_FILES);
    const versionFiles = versionFilesStr ? parseInt(versionFilesStr, 10) : 0;
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 天前

    let cleanedFiles = data.files;

    if (versionFiles < tenDaysAgo) {
      // 使用 cleanUnusedFiles 函數清理未使用的檔案
      cleanedFiles = cleanUnusedFiles(data.elements, data.files);
    }

    // 使用 saveToLocalStorage 函數儲存數據
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
  const fileIdsInElements = new Set<string>();

  elements.forEach((element) => {
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

// 將 excalidraw 狀態存入 localStorage
export function saveToLocalStorage(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
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

export const clearElementsForDatabase = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] =>
  getNonDeletedElements(elements).map((element) =>
    isLinearElementType(element.type)
      ? { ...element, lastCommittedPoint: null }
      : element,
  );

const getNonDeletedElements = <T extends ExcalidrawElement>(
  elements: readonly T[],
) =>
  elements.filter((element) => !element.isDeleted) as readonly NonDeleted<T>[];

function isLinearElementType(elementType: ElementOrToolType): boolean {
  return elementType === "arrow" || elementType === "line"; // || elementType === "freedraw"
}

export function isInitializedImageElement(
  element: ExcalidrawElement | null,
): element is InitializedExcalidrawImageElement {
  return !!element && element.type === "image" && !!element.fileId;
}
