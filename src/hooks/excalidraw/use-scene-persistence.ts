import { useCallback, useEffect, useRef, useState } from "react";
import { useDebounce } from "@/hooks/use-debounce";
import { saveData } from "@/lib/excalidraw";
import { saveOwnedWhiteboardDocumentToLocalStorage } from "@/data/local-storage";
import { useSceneSession } from "@/hooks/scene-session-context";
import type {
  WhiteboardDocument,
  WhiteboardEngine,
  WhiteboardPersistenceFormat,
} from "@/features/whiteboard";
import { recordWhiteboardDiagnostic } from "@/features/whiteboard";
import { toast } from "sonner";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

export type UseScenePersistenceResult = {
  sceneName: string;
  handleSetSceneName: (newName: string) => void;
};

export function useScenePersistence(
  engine?: WhiteboardEngine | null,
  persistenceFormat: WhiteboardPersistenceFormat = "legacy-excalidraw",
): UseScenePersistenceResult {
  const [sceneName, setSceneName] = useState<string>("");
  const localSaveWarningShownRef = useRef(false);
  const { t } = useStandaloneI18n();
  const persistDocument = useCallback(
    (document: WhiteboardDocument): void => {
      if (persistenceFormat === "whiteboard-v1") {
        const saved = saveOwnedWhiteboardDocumentToLocalStorage(document);
        if (!saved) {
          recordWhiteboardDiagnostic({
            operation: "save",
            outcome: "failure",
            engine: "owned",
            documentVersion: document.persistence?.documentVersion ?? null,
            errorCode: "UNKNOWN",
          });
          if (!localSaveWarningShownRef.current) {
            localSaveWarningShownRef.current = true;
            toast.error(t("app.localSave.toast.error"));
          }
        } else {
          localSaveWarningShownRef.current = false;
        }
        return;
      }
      saveData(
        {
          elements: document.elements as Parameters<
            typeof saveData
          >[0]["elements"],
          appState: document.state as Parameters<
            typeof saveData
          >[0]["appState"],
          files: document.assets as Parameters<typeof saveData>[0]["files"],
        },
        { syncOwnedDocument: false },
      );
    },
    [persistenceFormat, t],
  );
  const [debouncedSave] = useDebounce(persistDocument, 300);
  const { currentSceneId, markCurrentSceneDirty, shouldSuppressDirtyTracking } =
    useSceneSession();

  // Local flag for synchronous programmatic updates (e.g. handleSetSceneName).
  // Set to true before updateScene, reset immediately after — no timers needed
  // because updateScene triggers onChange synchronously within the same call stack.
  const skipDirtyRef = useRef(false);

  // 初始同步一次目前名稱
  useEffect(
    function syncInitialNameFromAPI() {
      if (!engine) return;
      try {
        setSceneName(engine.getEditorState().name);
      } catch {
        setSceneName("");
      }
    },
    [engine],
  );

  const handleSceneChange = useCallback(
    (document: WhiteboardDocument): void => {
      setSceneName(document.state.name ?? "");
      if (
        currentSceneId &&
        !skipDirtyRef.current &&
        !shouldSuppressDirtyTracking()
      ) {
        markCurrentSceneDirty();
      }
      debouncedSave(document);
    },
    [
      currentSceneId,
      debouncedSave,
      markCurrentSceneDirty,
      shouldSuppressDirtyTracking,
    ],
  );
  const handleSceneChangeRef = useRef(handleSceneChange);
  handleSceneChangeRef.current = handleSceneChange;

  useEffect(() => {
    if (!engine) return;
    return engine.subscribeDocument((document) => {
      handleSceneChangeRef.current(document);
    });
  }, [engine]);

  const handleSetSceneName = useCallback(
    (newName: string): void => {
      if (!engine) return;
      skipDirtyRef.current = true;
      try {
        engine.updateEditorState({ name: newName });
      } catch (error) {
        console.error("Failed to update scene name:", error);
      } finally {
        skipDirtyRef.current = false;
      }
    },
    [engine],
  );

  return { sceneName, handleSetSceneName };
}
