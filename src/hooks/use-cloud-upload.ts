"use client";

import { useCallback, useState } from "react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useUploadThing } from "@/lib/uploadthing";
import { createJsonBlob } from "@/lib/download";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-status";

export function useCloudUpload() {
  const [status, setStatus] = useState<UploadStatus>("idle");

  const { startUpload } = useUploadThing("sceneFileUploader", {
    onClientUploadComplete: () => {
      setStatus("success");
    },
    onUploadError: () => {
      setStatus("error");
    },
  });

  const uploadSceneToCloud = useCallback(
    async (
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): Promise<boolean> => {
      setStatus("uploading");

      try {
        const sceneData = {
          type: "excalidraw" as const,
          version: 2 as const,
          source: "https://excalidraw-ericts.vercel.app",
          elements,
          appState,
          files,
        };
        const blob = createJsonBlob(sceneData);
        const file = new File(
          [blob],
          `${appState.name ?? "scene"}.excalidraw`,
          { type: "application/json" },
        );

        await startUpload([file], {});
        // onClientUploadComplete 會設置為 success
        return true;
      } catch {
        setStatus("error");
        return false;
      }
    },
    [startUpload],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);

  return { uploadSceneToCloud, status, setStatus, resetStatus } as const;
}
