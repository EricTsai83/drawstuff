import { useCallback, useEffect, useRef, useState } from "react";
import { useDebounce } from "@/hooks/use-debounce";
import { saveOwnedWhiteboardDocumentToLocalStorage } from "@/data/local-storage";
import { useSceneSession } from "@/hooks/scene-session-context";
import type {
  OwnedWhiteboardDocument,
  WhiteboardEngine,
} from "@drawstuff/whiteboard";
import {
  recordWhiteboardDiagnostic,
  WHITEBOARD_DOCUMENT_VERSION,
} from "@drawstuff/whiteboard";
import { toast } from "sonner";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

export type UseScenePersistenceResult = {
  sceneName: string;
  handleSetSceneName: (newName: string) => void;
};

export function useScenePersistence(
  engine?: WhiteboardEngine | null,
): UseScenePersistenceResult {
  const [sceneName, setSceneName] = useState<string>("");
  const localSaveWarningShownRef = useRef(false);
  const { t } = useStandaloneI18n();
  const persistDocument = useCallback(
    (document: OwnedWhiteboardDocument): void => {
      const saved = saveOwnedWhiteboardDocumentToLocalStorage(document);
      if (!saved) {
        recordWhiteboardDiagnostic({
          operation: "save",
          outcome: "failure",
          documentVersion: WHITEBOARD_DOCUMENT_VERSION,
          errorCode: "UNKNOWN",
        });
        if (!localSaveWarningShownRef.current) {
          localSaveWarningShownRef.current = true;
          toast.error(t("app.localSave.toast.error"));
        }
      } else {
        localSaveWarningShownRef.current = false;
      }
    },
    [t],
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
    (document: OwnedWhiteboardDocument): void => {
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
