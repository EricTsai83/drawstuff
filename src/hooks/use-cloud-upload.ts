"use client";

import { useCallback, useState } from "react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useUploadThing } from "@/lib/uploadthing";
import { createJsonBlob } from "@/lib/download";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-status";

export function useCloudUpload() {
  // 與舊行為一致，預設顯示為 pending 狀態
  const [status, setStatus] = useState<UploadStatus>("pending");

  const { startUpload } = useUploadThing("sceneFileUploader", {
    onClientUploadComplete: () => {
      setStatus("success");
    },
    onUploadError: () => {
      setStatus("error");
    },
    onUploadBegin: () => {
      setStatus("uploading");
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
        // onClientUploadComplete 會設為 success
        return true;
      } catch {
        setStatus("error");
        return false;
      }
    },
    [startUpload],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);

  // 僅暴露受控 API，避免外部直接改狀態造成混亂
  return { uploadSceneToCloud, status, resetStatus } as const;
}
