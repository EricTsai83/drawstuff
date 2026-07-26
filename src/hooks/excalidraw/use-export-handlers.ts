import { useCallback } from "react";
import { toast } from "sonner";
import { getCurrentSceneSnapshot, saveSceneJsonToDisk } from "@/lib/excalidraw";
import type {
  WhiteboardAsset,
  WhiteboardDocumentState,
  WhiteboardElement,
  WhiteboardEngine,
} from "@/features/whiteboard";

type ExportDeps = {
  exportScene: (
    els: readonly WhiteboardElement[],
    state: WhiteboardDocumentState,
    fls: Readonly<Record<string, WhiteboardAsset>>,
  ) => Promise<string | null>;
  uploadSceneToCloud: () => Promise<boolean>;
  onShareSuccess?: (url: string) => void;
  isExporting: boolean;
  isUploading: boolean;
  engine?: WhiteboardEngine | null;
};

export function useExportHandlers({
  exportScene,
  uploadSceneToCloud,
  onShareSuccess,
  isExporting,
  isUploading,
  engine,
}: ExportDeps) {
  const handleSaveToDisk = useCallback(function handleSaveToDisk(
    elements: readonly WhiteboardElement[],
    appState: WhiteboardDocumentState,
    files: Readonly<Record<string, WhiteboardAsset>>,
  ): void {
    try {
      saveSceneJsonToDisk(
        elements as Parameters<typeof saveSceneJsonToDisk>[0],
        appState as Parameters<typeof saveSceneJsonToDisk>[1],
        files as Parameters<typeof saveSceneJsonToDisk>[2],
      );
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
        // 交由上層（Editor）統一處理錯誤 toast 與狀態重置
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error(errorObj);
      // 交由上層（Editor）統一處理錯誤 toast 與狀態重置
    }
  }, [uploadSceneToCloud]);

  const handleExportLink = useCallback(async (): Promise<void> => {
    if (isExporting || isUploading) return;
    const scene = getCurrentSceneSnapshot(engine);
    if (!scene) return;
    const url = await exportScene(scene.elements, scene.appState, scene.files);
    if (!url) return;
    onShareSuccess?.(url);
  }, [exportScene, onShareSuccess, isExporting, isUploading, engine]);

  return { handleSaveToDisk, handleCloudUpload, handleExportLink };
}
