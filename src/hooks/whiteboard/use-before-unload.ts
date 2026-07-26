import { useEffect, useCallback } from "react";
import { saveOwnedWhiteboardDocumentToLocalStorage } from "@/data/local-storage";
import type { WhiteboardEngine } from "@/features/whiteboard";
import { recordWhiteboardDiagnostic } from "@/features/whiteboard";
import { cleanUnusedWhiteboardAssets } from "@/lib/whiteboard";

export const useBeforeUnload = (engine: WhiteboardEngine | null) => {
  const handleBeforeUnload = useCallback(() => {
    if (!engine) return;
    const document = engine.getDocument();
    const elements = document.elements.filter((element) => !element.isDeleted);
    const saved = saveOwnedWhiteboardDocumentToLocalStorage({
      ...document,
      elements,
      assets: cleanUnusedWhiteboardAssets(elements, document.assets),
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
  }, [engine]);

  useEffect(() => {
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [handleBeforeUnload]);
};
