"use client";

import { useState, useCallback } from "react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { handleSceneSave, rollbackSharedScene } from "@/server/actions";
import { useUploadThing } from "@/lib/uploadthing";
import { nanoid } from "nanoid";
import { getBaseUrl } from "@/lib/base-url";

function cloneToArrayBuffer(
  fileBuffer: Uint8Array<ArrayBufferLike>,
): ArrayBuffer {
  const clonedBuffer = new Uint8Array(fileBuffer.length);
  clonedBuffer.set(fileBuffer);
  return clonedBuffer.buffer;
}

export type ExportStatus = "idle" | "exporting" | "success" | "error";

export function useSceneExport() {
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportErrorMessage, setExportErrorMessage] = useState<string | null>(
    null,
  );
  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const { startUpload: startSharedUpload } = useUploadThing(
    "sharedSceneFileUploader",
    {
      onClientUploadComplete: async (res) => {
        console.log("Files uploaded successfully!", res);
      },
      onUploadError: (error) => {
        console.error("Error occurred while uploading files", error);
        setExportErrorMessage("Error occurred while uploading files");
        setExportStatus("error");
      },
      onUploadBegin: (fileName) => {
        console.log("Upload has begun for", fileName);
      },
    },
  );

  const exportScene = useCallback(
    async (
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): Promise<string | null> => {
      if (exportStatus === "exporting") {
        setExportErrorMessage("Export already in progress");
        setExportStatus("error");
        return null;
      }

      if (elements.length === 0) {
        setExportErrorMessage("Cannot export empty canvas");
        setExportStatus("error");
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
            const safeBuffer = cloneToArrayBuffer(file.buffer);
            return new File([safeBuffer], uniqueId, {
              type: "application/octet-stream",
            });
          });
        }

        // 使用 server action 保存場景（共享連結）
        const result = await handleSceneSave(sceneData.compressedSceneData);

        // 若未取得 sharedSceneId，直接回報錯誤
        if (!result.sharedSceneId) {
          console.error("Failed to export scene:", result.errorMessage);
          setExportErrorMessage(
            result.errorMessage ?? "Failed to export scene",
          );
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

        // 有檔案才上傳（與 sharedSceneId 關聯的二進位素材）。
        // 若上傳失敗，回滾 sharedScene 並中止流程，不儲存 scene data。
        if (filesToUpload.length > 0) {
          try {
            const uploadResults = await startSharedUpload(filesToUpload, {
              sharedSceneId: result.sharedSceneId,
            });

            // startUpload 可能不會丟錯，但回傳筆數小於欲上傳數量時視為失敗
            const isUploadFailed =
              !uploadResults || uploadResults.length < filesToUpload.length;
            if (isUploadFailed) {
              setExportErrorMessage(
                "Some files failed to upload. Export canceled.",
              );
              await rollbackSharedScene(result.sharedSceneId);
              setExportStatus("error");
              return null;
            }
          } catch (uploadErr) {
            console.error("File upload failed:", uploadErr);
            setExportErrorMessage("File upload failed. Export canceled.");
            await rollbackSharedScene(result.sharedSceneId);
            setExportStatus("error");
            return null;
          }
        }

        // 移除重複的場景儲存邏輯，因為分享連結功能主要目的是建立共享連結
        // 而不是儲存到使用者的個人場景列表
        // 如果需要儲存到個人場景列表，應該使用 useCloudUpload hook

        setLatestShareableLink(shareableUrlString);
        setExportStatus("success");
        console.log("Scene exported successfully:", result.sharedSceneId);
        return shareableUrlString;
      } catch (error) {
        console.error("Error during scene export:", error);
        setExportErrorMessage("Error during scene export");
        setExportStatus("error");
        return null;
      }
    },
    [startSharedUpload, exportStatus],
  );

  const resetExportStatus = useCallback(() => {
    setExportStatus("idle");
    setExportErrorMessage(null);
  }, []);

  return {
    exportScene,
    exportStatus,
    exportErrorMessage,
    latestShareableLink,
    setLatestShareableLink,
    resetExportStatus,
  };
}
