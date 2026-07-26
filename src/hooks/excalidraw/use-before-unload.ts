import { useEffect, useCallback } from "react";
import { cleanUnusedFiles, saveToLocalStorage } from "@/lib/excalidraw";
import { saveOwnedWhiteboardDocumentToLocalStorage } from "@/data/local-storage";
import type {
  WhiteboardEngine,
  WhiteboardEngineKind,
} from "@/features/whiteboard";
import { recordWhiteboardDiagnostic } from "@/features/whiteboard";

export const useBeforeUnload = (
  engine: WhiteboardEngine | null,
  engineKind: WhiteboardEngineKind = "excalidraw",
) => {
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

    if (engineKind === "owned") {
      const saved = saveOwnedWhiteboardDocumentToLocalStorage({
        ...document,
        elements,
        assets: cleanedFiles,
      });
      if (!saved) {
        recordWhiteboardDiagnostic({
          operation: "save",
          outcome: "failure",
          engine: "owned",
          documentVersion: document.persistence?.documentVersion ?? null,
          errorCode: "UNKNOWN",
        });
      }
      return;
    }

    // 保存到 localStorage
    saveToLocalStorage(
      elements as unknown as Parameters<typeof saveToLocalStorage>[0],
      appState as Parameters<typeof saveToLocalStorage>[1],
      cleanedFiles,
      { syncOwnedDocument: false },
    );
  }, [engine, engineKind]);

  useEffect(() => {
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [handleBeforeUnload]);
};
