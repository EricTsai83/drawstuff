import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import type { OrderedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { isLocalScenePersistencePaused } from "@/data/local-scene-persistence";
import { useDebounce } from "@/hooks/use-debounce";
import { saveData } from "@/lib/excalidraw";
import { useSceneSession } from "@/hooks/scene-session-context";

export type UseScenePersistenceResult = {
  sceneName: string;
  handleSceneChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  handleSetSceneName: (newName: string) => void;
  cancelPendingSceneSave: () => void;
};

export function useScenePersistence(
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
): UseScenePersistenceResult {
  const [sceneName, setSceneName] = useState<string>("");
  const [debouncedSave, cancelPendingSave] = useDebounce(saveData, 300);
  const { currentSceneId, markCurrentSceneDirty, shouldSuppressDirtyTracking } =
    useSceneSession();

  // Local flag for synchronous programmatic updates (e.g. handleSetSceneName).
  // Set to true before updateScene, reset immediately after — no timers needed
  // because updateScene triggers onChange synchronously within the same call stack.
  const skipDirtyRef = useRef(false);

  // 初始同步一次目前名稱
  useEffect(
    function syncInitialNameFromAPI() {
      if (!excalidrawAPI) return;
      try {
        const currentName =
          (excalidrawAPI.getName?.() as string | undefined) ??
          excalidrawAPI.getAppState()?.name ??
          "";
        setSceneName(currentName ?? "");
      } catch {
        setSceneName("");
      }
    },
    [excalidrawAPI],
  );

  const handleSceneChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ): void => {
      setSceneName(appState.name ?? "");
      if (
        currentSceneId &&
        !skipDirtyRef.current &&
        !shouldSuppressDirtyTracking()
      ) {
        markCurrentSceneDirty();
      }
      // A room owns this canvas and there is no owned scene to cache it for, so
      // the local cache must not accumulate the room's content. Checked
      // synchronously (a memory read) because this runs on every `onChange`, and
      // a save queued before the pause is cancelled rather than left to fire.
      if (isLocalScenePersistencePaused()) {
        cancelPendingSave();
        return;
      }
      debouncedSave({ elements, appState, files });
    },
    [
      currentSceneId,
      debouncedSave,
      cancelPendingSave,
      markCurrentSceneDirty,
      shouldSuppressDirtyTracking,
    ],
  );

  const handleSetSceneName = useCallback(
    (newName: string): void => {
      if (!excalidrawAPI) return;
      skipDirtyRef.current = true;
      try {
        const currentAppState = excalidrawAPI.getAppState();
        excalidrawAPI.updateScene({
          appState: { ...currentAppState, name: newName },
        });
      } catch (error) {
        console.error("Failed to update scene name:", error);
      } finally {
        skipDirtyRef.current = false;
      }
    },
    [excalidrawAPI],
  );

  return {
    sceneName,
    handleSceneChange,
    handleSetSceneName,
    cancelPendingSceneSave: cancelPendingSave,
  };
}
