import { useCallback } from "react";
import { toast } from "sonner";
import { getCurrentSceneSnapshot, saveSceneJsonToDisk } from "@/lib/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
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
  const { t } = useStandaloneI18n();
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
    try {
      const ok = await uploadSceneToCloud();
      if (ok) {
        toast.success(t("toast.cloud.uploaded"));
      } else {
        // 交由上層（Editor）統一處理錯誤 toast 與狀態重置
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error(errorObj);
      // 交由上層（Editor）統一處理錯誤 toast 與狀態重置
    }
  }, [uploadSceneToCloud, t]);

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
