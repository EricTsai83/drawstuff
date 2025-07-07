import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { importFromLocalStorage } from "@/data/local-storage";
import { STORAGE_KEYS } from "@/config/app-constants";

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
          elements: localDataState.elements || [],
          appState: localDataState.appState || {},
          files: localDataState.files || {},
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

export function saveDataToLocalStorage(data: ExcalidrawInitialDataState) {
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify(data.elements),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(data.appState),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_FILES,
      JSON.stringify(data.files),
    );
  } catch (error) {
    console.error("保存數據失敗:", error);
  }
}
