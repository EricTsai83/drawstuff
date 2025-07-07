import { useEffect, useCallback } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { cleanUnusedFiles, saveToLocalStorage } from "@/lib/excalidraw";

export const useBeforeUnload = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) => {
  const handleBeforeUnload = useCallback(() => {
    if (!excalidrawAPI) return;

    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();

    // 清理未使用的文件
    const cleanedFiles = cleanUnusedFiles(elements, files);

    // 保存到 localStorage
    saveToLocalStorage(elements, appState, cleanedFiles);
  }, [excalidrawAPI]);

  useEffect(() => {
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [handleBeforeUnload]);
};
