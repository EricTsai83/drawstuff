import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { importFromLocalStorage } from "@/data/local-storage";

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
