"use client";

import { useState, useCallback } from "react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { handleSceneSave } from "@/server/actions";
import { useUploadThing } from "@/lib/uploadthing";
import { nanoid } from "nanoid";
import { env } from "@/env";
import { toast } from "sonner";

export type ExportStatus = "idle" | "exporting" | "success" | "error";

export function useSceneExport() {
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const { startUpload } = useUploadThing("sceneFileUploader", {
    onClientUploadComplete: async (res) => {
      console.log("Files uploaded successfully!", res);
    },
    onUploadError: (error) => {
      console.error("Error occurred while uploading files", error);
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
    ) => {
      if (elements.length === 0) {
        toast.error("Cannot export empty canvas");
        return;
      }

      setExportStatus("exporting");

      try {
        // 準備場景數據（只處理一次）
        const sceneData = await prepareSceneDataForExport(
          elements,
          appState,
          files,
        );

        // 如果有文件需要上傳，先上傳文件
        let filesToUpload: File[] = [];
        if (sceneData.compressedFilesData.length > 0) {
          // 將加密後的 Uint8Array 直接轉換為 File 對象用於上傳
          // 使用 nanoid 生成唯一 ID，對齊參考程式碼邏輯
          filesToUpload = sceneData.compressedFilesData.map((file) => {
            const uniqueId = nanoid(); // 使用 nanoid 生成唯一 ID
            return new File(
              [file.buffer], // 這裡的 buffer 已經是加密後的資料
              uniqueId, // 直接使用 nanoid ID 作為檔名
              {
                type: "application/octet-stream",
              },
            );
          });
        }

        // 直接使用 server action 保存場景，避免重複處理
        const result = await handleSceneSave(sceneData.compressedSceneData);

        // 生成分享鏈接
        const shareableUrl = new URL(env.NEXT_PUBLIC_BASE_URL);
        shareableUrl.hash = `json=${result.sharedSceneId},${sceneData.encryptionKey}`;

        // 使用 scene ID 作為 input 參數上傳文件
        await startUpload(filesToUpload, {
          sceneId: result.sharedSceneId,
        });

        if (result.sharedSceneId) {
          setLatestShareableLink(shareableUrl.toString());
          setExportStatus("success");
          console.log("Scene exported successfully:", result.sharedSceneId);
          return shareableUrl.toString();
        } else {
          console.error("Failed to export scene:", result.errorMessage);
          setExportStatus("error");
          return null;
        }
      } catch (error) {
        console.error("Error during scene export:", error);
        setExportStatus("error");
        return null;
      }
    },
    [startUpload],
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
