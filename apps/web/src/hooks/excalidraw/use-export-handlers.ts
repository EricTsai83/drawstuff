import { useCallback } from "react";
import { toast } from "sonner";
import { getCurrentSceneSnapshot, saveSceneJsonToDisk } from "@/lib/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

type ExportDeps = {
  exportScene: (
    els: readonly ExcalidrawElement[],
    state: Partial<AppState>,
    fls: BinaryFiles,
  ) => Promise<string | null>;
  uploadSceneToCloud: () => Promise<boolean>;
  onShareSuccess?: (url: string) => void;
  isExporting: boolean;
  isUploading: boolean;
  excalidrawAPI?: ExcalidrawImperativeAPI | null;
};

export function useExportHandlers({
  exportScene,
  uploadSceneToCloud,
  onShareSuccess,
  isExporting,
  isUploading,
  excalidrawAPI,
}: ExportDeps) {
  const { t } = useAppI18n();
  const handleSaveToDisk = useCallback(
    function handleSaveToDisk(
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): void {
      try {
        saveSceneJsonToDisk(elements, appState, files);
        toast.success(t("toast.export.fileSaved"));
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        console.error(errorObj);
        toast.error(t("toast.export.fileSaveFailed"));
      }
    },
    [t],
  );

  const handleCloudUpload = useCallback(async (): Promise<void> => {
    // uploadSceneToCloud reports success and failure itself.
    try {
      await uploadSceneToCloud();
    } catch (err: unknown) {
      console.error(err instanceof Error ? err : new Error(String(err)));
    }
  }, [uploadSceneToCloud]);

  const handleExportLink = useCallback(async (): Promise<void> => {
    if (isExporting || isUploading) return;
    const scene = getCurrentSceneSnapshot(excalidrawAPI);
    if (!scene) return;
    const url = await exportScene(scene.elements, scene.appState, scene.files);
    if (!url) return;
    onShareSuccess?.(url);
  }, [exportScene, onShareSuccess, isExporting, isUploading, excalidrawAPI]);

  return { handleSaveToDisk, handleCloudUpload, handleExportLink };
}
