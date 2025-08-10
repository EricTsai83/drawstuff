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
      toast.error("Error occurred while uploading files");
      setExportStatus("error");
    },
    onUploadBegin: (fileName) => {
      console.log("Upload has begun for", fileName);
    },
  });

  const exportScene = useCallback(
    async function exportScene(
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): Promise<string | null> {
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

        // 使用 server action 保存場景
        const result = await handleSceneSave(sceneData.compressedSceneData);

        // 若未取得 sceneId，直接回報錯誤
        if (!result?.sharedSceneId) {
          console.error("Failed to export scene:", result?.errorMessage);
          toast.error(result?.errorMessage ?? "Failed to export scene");
          setExportStatus("error");
          return null;
        }

        // 生成分享鏈接
        const shareableUrl = new URL(env.NEXT_PUBLIC_BASE_URL);
        shareableUrl.hash = `json=${result.sharedSceneId},${sceneData.encryptionKey}`;

        // 有檔案才上傳
        if (filesToUpload.length > 0) {
          await startUpload(filesToUpload, {
            sceneId: result.sharedSceneId,
          });
        }

        setLatestShareableLink(shareableUrl.toString());
        setExportStatus("success");
        console.log("Scene exported successfully:", result.sharedSceneId);
        return shareableUrl.toString();
      } catch (error) {
        console.error("Error during scene export:", error);
        toast.error("Error during scene export");
        setExportStatus("error");
        return null;
      }
    },
    [startUpload, exportStatus],
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
