import { useEffect, useCallback } from "react";
import { cleanUnusedFiles, saveToLocalStorage } from "@/lib/excalidraw";
import type { WhiteboardEngine } from "@/features/whiteboard";

export const useBeforeUnload = (engine: WhiteboardEngine | null) => {
  const handleBeforeUnload = useCallback(() => {
    if (!engine) return;
    const document = engine.getDocument();
    const elements = document.elements.filter((element) => !element.isDeleted);
    const appState = document.state;
    const files = document.assets;

    // 清理未使用的文件
    const cleanedFiles = cleanUnusedFiles(
      elements as unknown as Parameters<typeof cleanUnusedFiles>[0],
      files as Parameters<typeof cleanUnusedFiles>[1],
    );

    // 保存到 localStorage
    saveToLocalStorage(
      elements as unknown as Parameters<typeof saveToLocalStorage>[0],
      appState as Parameters<typeof saveToLocalStorage>[1],
      cleanedFiles,
    );
  }, [engine]);

  useEffect(() => {
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [handleBeforeUnload]);
};
