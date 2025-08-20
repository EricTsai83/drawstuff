import { useCallback } from "react";
import { toast } from "sonner";
import { getCurrentSceneSnapshot, saveSceneJsonToDisk } from "@/lib/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

type ExportDeps = {
  exportScene: (
    els: readonly NonDeletedExcalidrawElement[],
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
  const handleSaveToDisk = useCallback(function handleSaveToDisk(
    elements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ): void {
    try {
      saveSceneJsonToDisk(elements, appState, files);
      toast.success("File saved to disk successfully!");
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error(errorObj);
      toast.error("Failed to save file. Please try again.");
    }
  }, []);

  const handleCloudUpload = useCallback(async (): Promise<void> => {
    try {
      const ok = await uploadSceneToCloud();
      if (ok) {
        toast.success("Successfully uploaded to cloud!");
      } else {
        toast.error("Failed to upload to cloud. Please try again.");
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error(errorObj);
      toast.error("Failed to upload to cloud. Please try again.");
    }
  }, [uploadSceneToCloud]);

  const handleExportLink = useCallback(async (): Promise<void> => {
    if (isExporting || isUploading) return;
    const scene = getCurrentSceneSnapshot(excalidrawAPI);
    if (!scene) return;
    const url = await exportScene(
      scene.elements as readonly NonDeletedExcalidrawElement[],
      scene.appState,
      scene.files,
    );
    if (!url) {
      toast.error("Failed to export scene. Please try again.");
      return;
    }
    onShareSuccess?.(url);
  }, [exportScene, onShareSuccess, isExporting, isUploading, excalidrawAPI]);

  return { handleSaveToDisk, handleCloudUpload, handleExportLink };
}
