"use client";

import { useState, useCallback } from "react";
import type {
  AppState,
  BinaryFiles,
} from "@drawstuff/excalidraw-adapter/types";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { handleSceneSave, rollbackSharedScene } from "@/server/actions";
import { useUploadThing } from "@/lib/uploadthing";
import { getBaseUrl } from "@/lib/base-url";
import { DRAWSTUFF_DOCUMENT_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import { APP_ERROR } from "@/lib/errors";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

function cloneToArrayBuffer(
  fileBuffer: Uint8Array<ArrayBufferLike>,
): ArrayBuffer {
  const clonedBuffer = new Uint8Array(fileBuffer.length);
  clonedBuffer.set(fileBuffer);
  return clonedBuffer.buffer;
}

export type ExportStatus = "idle" | "exporting" | "success" | "error";

export function useSceneExport() {
  const { t } = useStandaloneI18n();
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
        setExportErrorMessage(t("errors.failedToExportScene"));
        setExportStatus("error");
      },
      onUploadBegin: (fileName) => {
        console.log("Upload has begun for", fileName);
      },
    },
  );

  const exportScene = useCallback(
    async (
      elements: readonly ExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): Promise<string | null> => {
      if (exportStatus === "exporting") {
        setExportErrorMessage(t("errors.exportInProgress"));
        setExportStatus("error");
        return null;
      }

      if (elements.length === 0) {
        setExportErrorMessage(t("errors.emptyCanvas"));
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
          { profile: "readonly-share" },
        );

        // 如果有文件需要上傳，先整理檔案。每個檔案帶自己的 Excalidraw file id
        // 作為身份，檔名不承載任何意義。
        const filesToUpload = sceneData.compressedFilesData.map((file) => ({
          file: new File([cloneToArrayBuffer(file.buffer)], "asset", {
            type: "application/octet-stream",
          }),
          excalidrawFileId: file.id,
        }));

        // 使用 server action 保存場景（共享連結）
        const result = await handleSceneSave(
          sceneData.compressedSceneData,
          DRAWSTUFF_DOCUMENT_VERSION,
        );

        // 若未取得 sharedSceneId，直接回報錯誤
        if (!result.sharedSceneId) {
          if (result.errorCode !== APP_ERROR.UNAUTHORIZED) {
            console.error("Failed to export scene:", result.errorMessage);
          }
          setExportErrorMessage(t("errors.failedToExportScene"));
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
            // 一個上傳一個 call：身份必須逐檔帶入，且任一檔失敗都要回滾整個
            // sharedScene，所以這裡等所有結果再判斷。
            const sharedSceneId = result.sharedSceneId;
            const uploadResults = await Promise.allSettled(
              filesToUpload.map(({ file, excalidrawFileId }) =>
                startSharedUpload([file], {
                  sharedSceneId,
                  excalidrawFileId,
                }),
              ),
            );

            // startUpload 可能不會丟錯，但沒有回傳恰好一筆時視為失敗
            const isUploadFailed = uploadResults.some(
              (entry) =>
                entry.status === "rejected" || entry.value?.length !== 1,
            );
            if (isUploadFailed) {
              setExportErrorMessage(t("errors.failedToExportScene"));
              await rollbackSharedScene(result.sharedSceneId);
              setExportStatus("error");
              return null;
            }
          } catch (uploadErr) {
            console.error("File upload failed:", uploadErr);
            setExportErrorMessage(t("errors.failedToExportScene"));
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
        setExportErrorMessage(t("errors.failedToExportScene"));
        setExportStatus("error");
        return null;
      }
    },
    [startSharedUpload, exportStatus, t],
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
