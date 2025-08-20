"use client";

import { useCallback, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-status";
import { api } from "@/trpc/react";
import { stringToBase64, toByteString } from "@/lib/encode";
import {
  getCurrentSceneSnapshot,
  exportSceneToPngBlob,
} from "@/lib/excalidraw";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { useUploadThing } from "@/lib/uploadthing";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export function useCloudUpload(excalidrawAPI?: ExcalidrawImperativeAPI | null) {
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
    async (existingSceneId?: string): Promise<boolean> => {
      setStatus("uploading");

      try {
        const scene = getCurrentSceneSnapshot(excalidrawAPI);
        if (!scene) {
          setStatus("error");
          return false;
        }

        const elements = scene.elements;
        const appState = scene.appState;
        const files = scene.files;

        // 準備資料（場景 JSON 與檔案皆壓縮；不加密）並存 DB
        try {
          // 利用與 export 相同的序列化流程，但不加密
          const prepared = await prepareSceneDataForExport(
            elements,
            appState,
            files,
            { encrypt: false },
          );
          const base64Data = stringToBase64(
            toByteString(prepared.compressedSceneData),
            true,
          );
          const safeName = (appState.name ?? "Untitled").trim() || "Untitled";
          const { id } = await saveSceneMutation.mutateAsync({
            id: existingSceneId,
            name: safeName,
            description: "",
            projectId: undefined,
            data: base64Data,
          });

          // 上傳壓縮檔案（不加密），與 sceneId 關聯
          const filesToUpload: File[] =
            prepared.compressedFilesData.length > 0
              ? prepared.compressedFilesData.map(
                  (f) =>
                    new File(
                      [f.buffer],
                      String((f as { id?: string }).id ?? "asset"),
                      {
                        type: "application/octet-stream",
                      },
                    ),
                )
              : [];

          if (id) {
            const uploadTasks: Promise<unknown>[] = [];

            if (filesToUpload.length > 0) {
              uploadTasks.push(
                startUpload(filesToUpload, {
                  sceneId: id,
                  fileKind: "asset",
                }),
              );
            }

            // 產生 PNG 縮圖並上傳（與 sceneId 關聯）— 與資產上傳並行
            uploadTasks.push(
              (async () => {
                try {
                  const pngBlob = await exportSceneToPngBlob(
                    elements as readonly NonDeletedExcalidrawElement[],
                    appState,
                    files,
                    1,
                  );
                  const thumbnailFile = new File([pngBlob], "thumbnail.png", {
                    type: "image/png",
                  });
                  await startUpload([thumbnailFile], {
                    sceneId: id,
                    fileKind: "thumbnail",
                  });
                } catch (thumbErr) {
                  // 縮圖失敗不影響整體流程
                  console.error(
                    "Failed to generate/upload thumbnail after cloud upload:",
                    thumbErr,
                  );
                }
              })(),
            );

            await Promise.all(uploadTasks);
          } else {
            console.error("No scene id returned from saveScene mutation");
            setStatus("error");
            return false;
          }
        } catch (e) {
          console.error("Failed to save scene record to DB:", e);
          setStatus("error");
          return false;
        }

        return true;
      } catch {
        setStatus("error");
        return false;
      }
    },
    [saveSceneMutation, startUpload, excalidrawAPI],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);

  // 僅暴露受控 API，避免外部直接改狀態造成混亂
  return { uploadSceneToCloud, status, resetStatus } as const;
}
