"use client";

import { useCallback, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-button";
import { api } from "@/trpc/react";
import { saveSceneAction } from "@/server/actions";
import { stringToBase64, toByteString } from "@/lib/encode";
import {
  getCurrentSceneSnapshot,
  exportSceneThumbnail,
} from "@/lib/excalidraw";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { useUploadThing } from "@/lib/uploadthing";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCurrentSceneId } from "@/hooks/use-current-scene-id";
import { toast } from "sonner";
import { useStandaloneI18n } from "@/lib/i18n";

export function useCloudUpload(
  onSceneNotFoundError: () => void,
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
  currentSceneId?: string,
) {
  const [status, setStatus] = useState<UploadStatus>("idle");
  const { saveCurrentSceneId, clearCurrentSceneId } = useCurrentSceneId();
  const utils = api.useUtils();
  const { t } = useStandaloneI18n();
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

  type UploadOptions = {
    existingSceneId?: string;
    name?: string;
    description?: string;
    categories?: string[];
    workspaceId?: string;
  };

  const uploadSceneToCloud = useCallback(
    async (options?: UploadOptions): Promise<boolean> => {
      setStatus("uploading");

      try {
        const scene = getCurrentSceneSnapshot(excalidrawAPI);
        if (!scene) {
          setStatus("error");
          toast.error(t("app.cloudUpload.toast.error.sceneData"));
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
            const result = await saveSceneAction({
              id: options?.existingSceneId ?? currentSceneId,
              name: options?.name ?? safeNameFromState,
              description: options?.description ?? "",
              workspaceId: options?.workspaceId,
              data: base64Data,
              categories: options?.categories,
            });
            id = result.id;
          } catch (err: unknown) {
            const errorObj =
              err instanceof Error ? err : new Error(String(err));
            // 場景找不到或是已經刪除，清除本地 sceneId 並改為建立新場景
            if (errorObj.message?.includes("SCENE_NOT_FOUND")) {
              clearCurrentSceneId();
              setStatus("idle"); // 重置狀態，避免顯示錯誤
              onSceneNotFoundError();
              // 場景找不到時，直接返回 false，避免顯示額外的錯誤 toast
              return false;
            } else {
              throw errorObj;
            }
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
            saveCurrentSceneId(String(id));
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

            // 顯示成功 toast
            toast.success(t("app.cloudUpload.toast.success"));

            // 完成雲端上傳後，讓清單失效以取得最新資料
            void utils.scene.getUserScenesList.invalidate();
          } else {
            setStatus("error");
            toast.error(t("app.cloudUpload.toast.error.saveScene"));
            return false;
          }
        } catch (e) {
          console.error("Failed to save scene record to DB:", e);
          setStatus("error");
          toast.error(t("app.cloudUpload.toast.error.upload"));
          return false;
        }

        return true;
      } catch {
        setStatus("error");
        toast.error(t("app.cloudUpload.toast.error.unknown"));
        return false;
      }
    },
    [
      assetUpload,
      thumbnailUpload,
      excalidrawAPI,
      utils,
      currentSceneId,
      t,
      onSceneNotFoundError,
      saveCurrentSceneId,
      clearCurrentSceneId,
    ],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);

  // 移除重複的 clearCurrentSceneId 函數，因為已經從 useCurrentSceneId hook 中獲取

  // 僅暴露受控 API，避免外部直接改狀態造成混亂
  return {
    uploadSceneToCloud,
    status,
    resetStatus,
    currentSceneId,
    clearCurrentSceneId,
  } as const;
}
