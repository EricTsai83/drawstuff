"use client";

import { useState, useCallback } from "react";
import { exportSceneThumbnail } from "@/lib/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { handleSceneSave } from "@/server/actions";
import { useUploadThing } from "@/lib/uploadthing";
import { nanoid } from "nanoid";
import { getBaseUrl } from "@/lib/base-url";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import { stringToBase64, toByteString } from "@/lib/encode";

export type ExportStatus = "idle" | "exporting" | "success" | "error";

export function useSceneExport() {
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const saveSceneMutation = api.scene.saveScene.useMutation();
  const utils = api.useUtils();

  const { startUpload } = useUploadThing("sceneFileUploader", {
    onClientUploadComplete: async (res) => {
      console.log("Files uploaded successfully!", res);
    },
    onUploadError: (error) => {
      console.error("Error occurred while uploading files", error);
      toast.error("Error occurred while uploading files");
      setExportStatus("error");
    },
    onUploadBegin: (fileName) => {
      console.log("Upload has begun for", fileName);
    },
  });

  const exportScene = useCallback(
    async (
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): Promise<string | null> => {
      if (exportStatus === "exporting") {
        toast.error("Export already in progress");
        return null;
      }

      if (elements.length === 0) {
        toast.error("Cannot export empty canvas");
        return null;
      }

      setExportStatus("exporting");

      try {
        // 準備場景數據（只處理一次）
        const sceneData = await prepareSceneDataForExport(
          elements,
          appState,
          files,
        );

        // 如果有文件需要上傳，先整理檔案
        let filesToUpload: File[] = [];
        if (sceneData.compressedFilesData.length > 0) {
          filesToUpload = sceneData.compressedFilesData.map((file) => {
            const uniqueId = nanoid();
            return new File([file.buffer], uniqueId, {
              type: "application/octet-stream",
            });
          });
        }

        // 使用 server action 保存場景（共享連結）
        const result = await handleSceneSave(sceneData.compressedSceneData);

        // 若未取得 sharedSceneId，直接回報錯誤
        if (!result?.sharedSceneId) {
          console.error("Failed to export scene:", result?.errorMessage);
          toast.error(result?.errorMessage ?? "Failed to export scene");
          setExportStatus("error");
          return null;
        }

        // 生成分享鏈接（使用安全的 base URL，避免 Invalid URL 錯誤）
        const base = getBaseUrl();
        let shareableUrlString = "";
        try {
          const u = new URL(base);
          u.hash = `json=${result.sharedSceneId},${sceneData.encryptionKey}`;
          shareableUrlString = u.toString();
        } catch {
          const origin =
            typeof window !== "undefined"
              ? window.location.origin
              : "http://localhost:3000";
          const u = new URL(origin);
          u.hash = `json=${result.sharedSceneId},${sceneData.encryptionKey}`;
          shareableUrlString = u.toString();
        }

        // 有檔案才上傳（與 sharedSceneId 關聯的二進位素材）
        if (filesToUpload.length > 0) {
          await startUpload(filesToUpload, {
            sharedSceneId: result.sharedSceneId,
          });
        }

        // 將場景儲存到使用者的 scene 表，供 Dashboard 搜尋/顯示
        try {
          const base64Data = stringToBase64(
            toByteString(sceneData.compressedSceneData),
            true,
          );
          const safeName = (appState.name ?? "Untitled").trim() || "Untitled";
          const { id } = await saveSceneMutation.mutateAsync({
            name: safeName,
            description: "",
            projectId: undefined,
            data: base64Data,
          });

          // 產生 PNG 縮圖（遵循目前 theme），並上傳到 UploadThing，與 sceneId 關聯
          try {
            const pngBlob = await exportSceneThumbnail(
              elements,
              appState,
              files,
              { quality: 1 },
            );
            const thumbnailFile = new File([pngBlob], "thumbnail.png", {
              type: "image/png",
            });
            await startUpload([thumbnailFile], {
              sceneId: id,
              fileKind: "thumbnail",
            });
          } catch (thumbErr) {
            console.error("Failed to generate/upload thumbnail:", thumbErr);
          }

          // 讓使用者場景清單失效，確保下一次讀取是最新資料
          void utils.scene.getUserScenesList.invalidate();
        } catch (e) {
          console.error("Failed to save scene record:", e);
          // 不阻斷分享流程，但提示失敗
          toast.error("Scene saved to dashboard failed");
        }

        setLatestShareableLink(shareableUrlString);
        setExportStatus("success");
        console.log("Scene exported successfully:", result.sharedSceneId);
        return shareableUrlString;
      } catch (error) {
        console.error("Error during scene export:", error);
        toast.error("Error during scene export");
        setExportStatus("error");
        return null;
      }
    },
    [startUpload, exportStatus, saveSceneMutation, utils],
  );

  const resetExportStatus = useCallback(() => {
    setExportStatus("idle");
  }, []);

  return {
    exportScene,
    exportStatus,
    latestShareableLink,
    setLatestShareableLink,
    resetExportStatus,
  };
}
