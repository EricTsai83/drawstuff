import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { STORAGE_KEYS } from "@/config/app-constants";

// ====== 自行實作 Excalidraw 狀態相關 helper ======

function getDefaultAppState(): Partial<AppState> {
  return {
    theme: "light",
    viewBackgroundColor: "#ffffff",
    gridSize: undefined,
    name: "", // 新增預設的 name 欄位
    // 可依需求補充預設值
  };
}

function clearAppStateForLocalStorage(
  appState: Partial<AppState>,
): Partial<AppState> {
  // 只保留你想存的欄位
  const {
    theme,
    viewBackgroundColor,
    gridSize,
    name, // 新增 name 欄位
    // ...其他你想保留的欄位
  } = appState;
  return { theme, viewBackgroundColor, gridSize, name }; // 返回時包含 name
}

function clearElementsForLocalStorage(
  elements: OrderedExcalidrawElement[],
): OrderedExcalidrawElement[] {
  // 過濾掉 isDeleted 的元素
  return Array.isArray(elements) ? elements.filter((el) => !el.isDeleted) : [];
}

export const importFromLocalStorage = () => {
  let savedElements: string | null = null;
  let savedState: string | null = null;
  let savedFiles: string | null = null;

  try {
    savedElements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    savedState = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
    savedFiles = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES);
  } catch (error: unknown) {
    // Unable to access localStorage
    console.error(error);
  }

  let elements: OrderedExcalidrawElement[] = [];
  if (savedElements) {
    try {
      elements = clearElementsForLocalStorage(
        JSON.parse(savedElements) as OrderedExcalidrawElement[],
      );
    } catch (error: unknown) {
      console.error(error);
      // Do nothing because elements array is already empty
    }
  }

  let appState: Partial<AppState> | null = null;
  if (savedState) {
    try {
      appState = {
        ...getDefaultAppState(),
        ...clearAppStateForLocalStorage(
          JSON.parse(savedState) as Partial<AppState>,
        ),
      };
    } catch (error: unknown) {
      console.error(error);
      // Do nothing because appState is already null
    }
  }

  let files: BinaryFiles = {};
  if (savedFiles) {
    try {
      files = JSON.parse(savedFiles) as BinaryFiles;
    } catch (error: unknown) {
      console.error(error);
      // Do nothing because files is already empty object
    }
  }

  return { elements, appState, files };
};

export const getElementsStorageSize = () => {
  try {
    const elements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    const elementsSize = elements?.length ?? 0;
    return elementsSize;
  } catch (error: unknown) {
    console.error(error);
    return 0;
  }
};

export const getTotalStorageSize = () => {
  try {
    // 根據實際的 STORAGE_KEYS 配置計算
    const excalidrawKeys = [
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, // "excalidraw"
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, // "excalidraw-state"
      STORAGE_KEYS.LOCAL_STORAGE_FILES, // "excalidraw-files"
      STORAGE_KEYS.LOCAL_STORAGE_THEME, // "theme"
      STORAGE_KEYS.VERSION_DATA_STATE, // "version-dataState"
      STORAGE_KEYS.VERSION_FILES, // "version-files"
      STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, // "i18nextLng"
      STORAGE_KEYS.IDB_LIBRARY, // "excalidraw-library"
    ];

    let totalSize = 0;

    excalidrawKeys.forEach((key) => {
      const value = localStorage.getItem(key);
      if (value) {
        // 使用 UTF-16 編碼計算（每字符 2 字節）
        const itemSize = (key.length + value.length) * 2;
        totalSize += itemSize;
      }
    });

    return totalSize;
  } catch (error: unknown) {
    console.error(error);
    return 0;
  }
};
