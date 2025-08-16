import { useCallback, useEffect, useState } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useDebounce } from "@/hooks/use-debounce";
import { saveData } from "@/lib/excalidraw";

export type UseScenePersistenceResult = {
  sceneName: string;
  handleSceneChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  handleSetSceneName: (newName: string) => void;
};

export function useScenePersistence(
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
): UseScenePersistenceResult {
  const [sceneName, setSceneName] = useState<string>("");
  const [debouncedSave] = useDebounce(saveData, 300);

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
      debouncedSave({ elements, appState, files });
    },
    [debouncedSave],
  );

  const handleSetSceneName = useCallback(
    (newName: string): void => {
      if (!excalidrawAPI) return;
      try {
        const currentAppState = excalidrawAPI.getAppState();
        excalidrawAPI.updateScene({
          appState: { ...currentAppState, name: newName },
        });
      } catch (error) {
        console.error("Failed to update scene name:", error);
      }
    },
    [excalidrawAPI],
  );

  return { sceneName, handleSceneChange, handleSetSceneName };
}
