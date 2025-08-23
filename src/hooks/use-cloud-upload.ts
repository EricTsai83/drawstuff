"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-button";
import { api } from "@/trpc/react";
import { stringToBase64, toByteString } from "@/lib/encode";
import {
  getCurrentSceneSnapshot,
  exportSceneThumbnail,
} from "@/lib/excalidraw";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { useUploadThing } from "@/lib/uploadthing";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneIdToStorage,
  clearCurrentSceneIdFromStorage,
} from "@/data/local-storage";

export function useCloudUpload(excalidrawAPI?: ExcalidrawImperativeAPI | null) {
  // 與舊行為一致，預設顯示為 pending 狀態
  const [status, setStatus] = useState<UploadStatus>("pending");
  const [currentSceneId, setCurrentSceneId] = useState<string | undefined>(
    undefined,
  );
  const saveSceneMutation = api.scene.saveScene.useMutation();
  const utils = api.useUtils();
  const assetUpload = useUploadThing("sceneAssetUploader", {
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
  const thumbnailUpload = useUploadThing("sceneThumbnailUploader");

  // 初始化從 localStorage 載入 sceneId（local-first）
  useEffect(() => {
    const stored = loadCurrentSceneIdFromStorage();
    if (stored) setCurrentSceneId(stored);
  }, []);

  type UploadOptions = {
    existingSceneId?: string;
    name?: string;
    description?: string;
    categories?: string[];
  };

  const uploadSceneToCloud = useCallback(
    async (options?: UploadOptions): Promise<boolean> => {
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
          const safeNameFromState =
            (appState.name ?? "Untitled").trim() || "Untitled";
          let id: string | undefined;
          try {
            const result = await saveSceneMutation.mutateAsync({
              id: options?.existingSceneId ?? currentSceneId,
              name: options?.name ?? safeNameFromState,
              description: options?.description ?? "",
              projectId: undefined,
              data: base64Data,
              categories: options?.categories,
            });
            id = result.id;
          } catch (err: unknown) {
            const errorObj =
              err instanceof Error ? err : new Error(String(err));
            // 若是無效或無權限的 sceneId，清除本地 sceneId，讓後續走首次儲存流程
            if (errorObj.message?.includes("SCENE_NOT_FOUND_OR_FORBIDDEN")) {
              clearCurrentSceneIdFromStorage();
              setCurrentSceneId(undefined);
            }
            throw errorObj;
          }

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
            setCurrentSceneId(id);
            saveCurrentSceneIdToStorage(String(id));
            const uploadTasks: Promise<unknown>[] = [];

            if (filesToUpload.length > 0) {
              // 逐檔計算 SHA-256 並帶入 contentHash，並行上傳
              const perFileUploads = filesToUpload.map(async (file) => {
                const buf = await file.arrayBuffer();
                const digest = await crypto.subtle.digest("SHA-256", buf);
                const hashArray = Array.from(new Uint8Array(digest));
                const contentHash = hashArray
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("");
                return assetUpload.startUpload([file], {
                  sceneId: id,
                  contentHash,
                });
              });
              uploadTasks.push(Promise.all(perFileUploads));
            }

            // 產生 PNG 縮圖並上傳（與 sceneId 關聯）— 與資產上傳並行
            uploadTasks.push(
              (async () => {
                try {
                  const pngBlob = await exportSceneThumbnail(
                    elements as readonly NonDeletedExcalidrawElement[],
                    appState,
                    files,
                  );
                  const thumbnailFile = new File([pngBlob], "thumbnail.png", {
                    type: "image/png",
                  });
                  await thumbnailUpload.startUpload([thumbnailFile], {
                    sceneId: id,
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
            // 若沒有資產需要上傳，或所有並行任務皆已完成，明確標記為成功
            setStatus("success");

            // 完成雲端上傳後，讓清單失效以取得最新資料
            void utils.scene.getUserScenesList.invalidate();
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
    [
      saveSceneMutation,
      assetUpload,
      thumbnailUpload,
      excalidrawAPI,
      utils,
      currentSceneId,
    ],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);

  const clearCurrentSceneId = useCallback(() => {
    setCurrentSceneId(undefined);
    clearCurrentSceneIdFromStorage();
  }, []);

  // 僅暴露受控 API，避免外部直接改狀態造成混亂
  return {
    uploadSceneToCloud,
    status,
    resetStatus,
    currentSceneId,
    clearCurrentSceneId,
  } as const;
}
