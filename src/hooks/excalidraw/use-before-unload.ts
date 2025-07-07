import { useEffect } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { STORAGE_KEYS } from "@/config/app-constants";

export const useBeforeUnload = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) => {
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (excalidrawAPI) {
        const elements = excalidrawAPI.getSceneElements();
        const appState = excalidrawAPI.getAppState();
        const files = excalidrawAPI.getFiles();

        try {
          // 分別保存到對應的 key
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
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [excalidrawAPI]);
};
