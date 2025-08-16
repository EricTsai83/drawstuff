import { useCallback } from "react";
import { toast } from "sonner";
import { createJsonBlob, triggerBlobDownload } from "@/lib/download";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawSceneData } from "@/lib/excalidraw";

type ExportDeps = {
  exportScene: (
    els: readonly NonDeletedExcalidrawElement[],
    state: Partial<AppState>,
    fls: BinaryFiles,
  ) => Promise<string | null>;
  uploadSceneToCloud: (
    els: readonly NonDeletedExcalidrawElement[],
    state: Partial<AppState>,
    fls: BinaryFiles,
  ) => Promise<boolean>;
  onShareSuccess?: (url: string) => void;
  isExporting: boolean;
  isUploading: boolean;
};

export function useExportHandlers({
  exportScene,
  uploadSceneToCloud,
  onShareSuccess,
  isExporting,
  isUploading,
}: ExportDeps) {
  const handleSaveToDisk = useCallback(function handleSaveToDisk(
    els: readonly NonDeletedExcalidrawElement[],
    state: Partial<AppState>,
    fls: BinaryFiles,
  ): void {
    try {
      const sceneData: ExcalidrawSceneData = {
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: els,
        appState: state,
        files: fls,
      };
      const blob = createJsonBlob(sceneData);
      triggerBlobDownload(`${state.name ?? "scene"}.excalidraw`, blob);
      toast.success("File saved to disk successfully!");
    } catch (err) {
      console.error(err);
      toast.error("Failed to save file. Please try again.");
    }
  }, []);

  const handleCloudUpload = useCallback(
    async function handleCloudUpload(
      els: readonly NonDeletedExcalidrawElement[],
      state: Partial<AppState>,
      fls: BinaryFiles,
    ): Promise<void> {
      try {
        const ok = await uploadSceneToCloud(els, state, fls);
        toast[ok ? "success" : "error"](
          ok
            ? "Successfully uploaded to cloud!"
            : "Failed to upload to cloud. Please try again.",
        );
      } catch (err) {
        console.error(err);
        toast.error("Failed to upload to cloud. Please try again.");
      }
    },
    [uploadSceneToCloud],
  );

  const handleExportLink = useCallback(
    async function handleExportLink(
      els: readonly NonDeletedExcalidrawElement[],
      state: Partial<AppState>,
      fls: BinaryFiles,
    ): Promise<void> {
      if (isExporting || isUploading) return;
      const url = await exportScene(els, state, fls);
      if (!url) {
        toast.error("Failed to export scene. Please try again.");
        return;
      }
      onShareSuccess?.(url);
    },
    [exportScene, onShareSuccess, isExporting, isUploading],
  );

  return { handleSaveToDisk, handleCloudUpload, handleExportLink };
}
