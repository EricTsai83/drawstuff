"use client";

import { useCallback, useRef, useState } from "react";
import type {
  AppState,
  BinaryFiles,
} from "@drawstuff/excalidraw-adapter/types";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { handleSceneSave, rollbackSharedScene } from "@/server/actions";
import { useUploadThing } from "@/lib/uploadthing";
import { getBaseUrl } from "@/lib/base-url";
import { buildSharedSceneUrl } from "@/lib/shared-scene-link";
import { normalizeToArrayBuffer } from "@/lib/array-buffer";
import { DRAWSTUFF_DOCUMENT_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import { APP_ERROR } from "@/lib/errors";
import { useAppI18n } from "@/hooks/use-app-i18n";

export type ExportStatus = "idle" | "exporting" | "success" | "error";

export function useSceneExport() {
  const { t } = useAppI18n();
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportErrorMessage, setExportErrorMessage] = useState<string | null>(
    null,
  );
  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );
  // State lags a render behind, so two clicks in the same frame would both
  // read "idle"; the ref is the synchronous in-flight guard.
  const inFlightRef = useRef(false);

  const { startUpload: startSharedUpload } = useUploadThing(
    "sharedSceneFileUploader",
    {
      onUploadError: (error) => {
        console.error("Error occurred while uploading files", error);
        setExportErrorMessage(t("errors.failedToExportScene"));
        setExportStatus("error");
      },
    },
  );

  const exportScene = useCallback(
    async (
      elements: readonly ExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
    ): Promise<string | null> => {
      if (inFlightRef.current) {
        setExportErrorMessage(t("errors.exportInProgress"));
        setExportStatus("error");
        return null;
      }

      if (elements.length === 0) {
        setExportErrorMessage(t("errors.emptyCanvas"));
        setExportStatus("error");
        return null;
      }

      inFlightRef.current = true;
      setExportStatus("exporting");

      const fail = () => {
        setExportErrorMessage(t("errors.failedToExportScene"));
        setExportStatus("error");
        return null;
      };

      try {
        // 準備場景數據（只處理一次）
        const sceneData = await prepareSceneDataForExport(
          elements,
          appState,
          files,
          { profile: "readonly-share" },
        );

        // 分享連結一定加密（encrypt 預設為 true），沒有金鑰就不能產生可讀的連結
        if (!sceneData.encryptionKey) {
          throw new Error("Share export produced no encryption key");
        }
        const { encryptionKey } = sceneData;

        // 如果有文件需要上傳，先整理檔案。每個檔案帶自己的 Excalidraw file id
        // 作為身份，檔名不承載任何意義。
        const filesToUpload = sceneData.compressedFilesData.map((file) => ({
          file: new File([normalizeToArrayBuffer(file.buffer)], "asset", {
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
          return fail();
        }
        const { sharedSceneId } = result;

        // 有檔案才上傳（與 sharedSceneId 關聯的二進位素材）。一個上傳一個
        // call：身份必須逐檔帶入。任一檔失敗（reject，或沒有恰好回傳一筆）
        // 都要回滾整個 sharedScene，不留下缺圖的分享連結。
        if (filesToUpload.length > 0) {
          const uploadResults = await Promise.allSettled(
            // async wrapper: a synchronous throw must also count as a failed
            // upload and reach the rollback below.
            filesToUpload.map(async ({ file, excalidrawFileId }) =>
              startSharedUpload([file], { sharedSceneId, excalidrawFileId }),
            ),
          );
          const uploadFailed = uploadResults.some(
            (entry) => entry.status === "rejected" || entry.value?.length !== 1,
          );
          if (uploadFailed) {
            await rollbackSharedScene(sharedSceneId);
            return fail();
          }
        }

        const shareableUrlString = buildSharedSceneUrl(getBaseUrl(), {
          id: sharedSceneId,
          key: encryptionKey,
        });

        setLatestShareableLink(shareableUrlString);
        setExportStatus("success");
        return shareableUrlString;
      } catch (error) {
        console.error("Error during scene export:", error);
        return fail();
      } finally {
        inFlightRef.current = false;
      }
    },
    [startSharedUpload, t],
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
