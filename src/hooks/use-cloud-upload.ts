"use client";

import { useCallback, useState } from "react";
import { exportToBlob } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useUploadThing } from "@/lib/uploadthing";
import { createJsonBlob } from "@/lib/download";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-status";
import { api } from "@/trpc/react";
import { stringToBase64, toByteString } from "@/lib/encode";

export function useCloudUpload() {
  // 與舊行為一致，預設顯示為 pending 狀態
  const [status, setStatus] = useState<UploadStatus>("pending");
  const saveSceneMutation = api.scene.saveScene.useMutation();

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

        // 上傳成功後，寫入 scene 表供 Dashboard 使用
        try {
          const buffer = new Uint8Array(await blob.arrayBuffer());
          const base64Data = stringToBase64(toByteString(buffer), true);
          const safeName = (appState.name ?? "Untitled").trim() || "Untitled";
          const { id } = await saveSceneMutation.mutateAsync({
            name: safeName,
            description: "",
            projectId: undefined,
            data: base64Data,
          });

          // 產生 PNG 縮圖並上傳，與 sceneId 關聯
          try {
            const pngBlob = await (
              exportToBlob as unknown as (args: {
                elements: readonly NonDeletedExcalidrawElement[];
                appState: Partial<AppState>;
                files: BinaryFiles;
                mimeType: "image/png";
                quality: number;
              }) => Promise<Blob>
            )({
              elements,
              appState,
              files,
              mimeType: "image/png",
              quality: 1,
            });
            const thumbnailFile = new File([pngBlob], "thumbnail.png", {
              type: "image/png",
            });
            await startUpload([thumbnailFile], {
              sceneId: id,
              fileKind: "thumbnail",
            });
          } catch (thumbErr) {
            console.error(
              "Failed to generate/upload thumbnail after cloud upload:",
              thumbErr,
            );
          }
        } catch (e) {
          console.error("Failed to save scene record after cloud upload:", e);
        }
        // onClientUploadComplete 會設為 success
        return true;
      } catch {
        setStatus("error");
        return false;
      }
    },
    [startUpload, saveSceneMutation],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);

  // 僅暴露受控 API，避免外部直接改狀態造成混亂
  return { uploadSceneToCloud, status, resetStatus } as const;
}
