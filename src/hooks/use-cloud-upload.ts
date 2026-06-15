"use client";

import { useCallback, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-button";
import { api } from "@/trpc/react";
import { saveSceneAction } from "@/server/actions";
import { stringToBase64, toByteString } from "@/lib/encode";
import { normalizeToArrayBuffer } from "@/lib/array-buffer";
import {
  getCurrentSceneSnapshot,
  exportSceneThumbnail,
} from "@/lib/excalidraw";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { useUploadThing } from "@/lib/uploadthing";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import { toast } from "sonner";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { APP_ERROR } from "@/lib/errors";
import { getSceneMetaBySceneId } from "@/lib/import-data-from-db";

export type SceneConflictInfo = {
  sceneId: string;
  remoteRevision?: number;
};

export function useCloudUpload(
  onSceneNotFoundError: () => void,
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
) {
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [lastConflict, setLastConflict] = useState<SceneConflictInfo | null>(
    null,
  );
  const {
    currentSceneId,
    currentWorkspaceId,
    lastSyncedRevision,
    syncCurrentScene,
    clearCurrentScene,
    markCurrentSceneDirty,
    updateLastSyncedRevision,
  } = useSceneSession();
  const currentSceneIdRef = useRef<string | undefined>(currentSceneId);
  currentSceneIdRef.current = currentSceneId;
  const currentWorkspaceIdRef = useRef<string | undefined>(currentWorkspaceId);
  currentWorkspaceIdRef.current = currentWorkspaceId;
  const lastSyncedRevisionRef = useRef<number | undefined>(lastSyncedRevision);
  lastSyncedRevisionRef.current = lastSyncedRevision;
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
  const { mutateAsync: deleteSceneAsync } = api.scene.deleteScene.useMutation();

  type UploadOptions = {
    existingSceneId?: string;
    name?: string;
    description?: string;
    categories?: string[];
    workspaceId?: string;
    suppressSuccessToast?: boolean;
    // 指定上傳模式：
    // - "create": 強制建立新場景（忽略 existingSceneId 與 currentSceneId）
    // - "update": 更新既有場景（若未提供 existingSceneId，會回退到目前 context 的 sceneId）
    // 若未指定，將自動依據 existingSceneId 或目前 context 決定行為（向下相容）
    mode?: "create" | "update";
  };

  const uploadSceneToCloud = useCallback(
    async (options?: UploadOptions): Promise<boolean> => {
      setStatus("uploading");
      setLastConflict(null);

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

          // 依據 mode 推導有效的 sceneId 與行為
          const mode = options?.mode;
          let effectiveSceneId: string | undefined;
          if (mode === "create") {
            // 明確要求建立，不帶 id
            effectiveSceneId = undefined;
          } else if (mode === "update") {
            // 明確要求更新，若未提供則回退到 context 的 sceneId
            effectiveSceneId =
              options?.existingSceneId ?? currentSceneIdRef.current;
            if (!effectiveSceneId) {
              setStatus("error");
              toast.error(t("app.cloudUpload.toast.error.noSceneToUpdate"));
              return false;
            }
          } else {
            // 未指定 mode：向下相容，依 existingSceneId 或 context 判斷
            effectiveSceneId =
              options?.existingSceneId ?? currentSceneIdRef.current;
          }

          // Auto-recover missing revision: fetch from remote before saving.
          // Only the ref is updated here — we intentionally avoid calling
          // syncCurrentScene() because it would reset isDirty to false while
          // we are in the middle of uploading dirty content.
          // The server-side optimistic lock is the real safety net — if another
          // client updated in between, the server rejects with SCENE_CONFLICT.
          if (
            effectiveSceneId !== undefined &&
            lastSyncedRevisionRef.current === undefined
          ) {
            try {
              const remoteMeta = await getSceneMetaBySceneId(effectiveSceneId);
              if (remoteMeta?.revision !== undefined) {
                lastSyncedRevisionRef.current = remoteMeta.revision;
              }
            } catch {
              // ignore fetch errors — will proceed without revision
            }
            if (lastSyncedRevisionRef.current === undefined) {
              setStatus("error");
              toast.error(
                "Unable to verify scene version. Please reload and try again.",
              );
              return false;
            }
          }

          // 優先使用呼叫端顯式傳入的 workspaceId（例如首次上傳 Dialog），
          // 其次使用 session 記錄的場景所屬 workspaceId
          const effectiveWorkspaceId =
            options?.workspaceId ?? currentWorkspaceIdRef.current;
          if (!effectiveWorkspaceId) {
            setStatus("error");
            toast.error("Workspace is required to upload");
            return false;
          }

          const result = await saveSceneAction({
            id: effectiveSceneId,
            name: options?.name ?? safeNameFromState,
            description: options?.description ?? "",
            workspaceId: effectiveWorkspaceId,
            data: base64Data,
            categories: options?.categories,
            expectedRevision:
              effectiveSceneId !== undefined
                ? lastSyncedRevisionRef.current
                : undefined,
          });
          if (!result.ok) {
            if (result.error === APP_ERROR.SCENE_NOT_FOUND) {
              clearCurrentScene();
              setStatus("idle");
              onSceneNotFoundError();
              return false;
            }
            if (result.error === APP_ERROR.SCENE_CONFLICT) {
              setStatus("idle");
              setLastConflict({
                sceneId:
                  result.data?.id ??
                  effectiveSceneId ??
                  currentSceneIdRef.current ??
                  "",
                remoteRevision: result.data?.revision,
              });
              return false;
            }
            throw new Error(result.message ?? result.error);
          }
          const { id, revision } = result.data;
          const createdNewScene = effectiveSceneId === undefined;

          // 上傳壓縮檔案（不加密），與 sceneId 關聯
          const filesToUpload: File[] =
            prepared.compressedFilesData.length > 0
              ? prepared.compressedFilesData.map((f) => {
                  const bufferForFile = normalizeToArrayBuffer(f.buffer);
                  return new File(
                    [bufferForFile],
                    String((f as { id?: string }).id ?? "asset"),
                    {
                      type: "application/octet-stream",
                    },
                  );
                })
              : [];

          if (id) {
            const uploadTasks: Promise<void>[] = [];

            if (filesToUpload.length > 0) {
              // 逐檔計算 SHA-256 並帶入 contentHash，並行上傳
              const perFileUploads = filesToUpload.map(async (file) => {
                const buf = await file.arrayBuffer();
                const digest = await crypto.subtle.digest("SHA-256", buf);
                const hashArray = Array.from(new Uint8Array(digest));
                const contentHash = hashArray
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("");
                const uploadResult = await assetUpload.startUpload([file], {
                  sceneId: id,
                  contentHash,
                });
                if (uploadResult?.length !== 1) {
                  throw new Error(`Asset upload failed for ${file.name}`);
                }
              });
              uploadTasks.push(
                Promise.all(perFileUploads).then(() => undefined),
              );
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

            try {
              await Promise.all(uploadTasks);
            } catch (uploadErr) {
              console.error("Asset upload failed after scene save:", uploadErr);
              markCurrentSceneDirty();
              if (createdNewScene) {
                try {
                  await deleteSceneAsync({ id });
                } catch (rollbackErr) {
                  console.error(
                    "Failed to rollback newly-created scene after asset upload failure:",
                    rollbackErr,
                  );
                }
              } else {
                updateLastSyncedRevision(revision);
              }
              setStatus("error");
              toast.error(t("app.cloudUpload.toast.error.upload"));
              return false;
            }
            // Sync session (id + revision + workspaceId) only after all uploads succeed,
            // so isDirty remains true if uploads fail.
            syncCurrentScene({
              id: String(id),
              revision,
              workspaceId: effectiveWorkspaceId,
            });
            // 若沒有資產需要上傳，或所有並行任務皆已完成，明確標記為成功
            setStatus("success");

            // 可選地顯示成功 toast（由呼叫端統一顯示避免重複）
            if (!options?.suppressSuccessToast) {
              toast.success(t("app.cloudUpload.toast.success"));
            }

            // 完成雲端上傳後，讓清單失效以取得最新資料
            void utils.scene.getUserScenesInfinite.invalidate();
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
      deleteSceneAsync,
      excalidrawAPI,
      utils,
      t,
      onSceneNotFoundError,
      syncCurrentScene,
      clearCurrentScene,
      markCurrentSceneDirty,
      updateLastSyncedRevision,
    ],
  );

  const resetStatus = useCallback(() => setStatus("idle"), []);
  const clearLastConflict = useCallback(() => setLastConflict(null), []);

  // 僅暴露受控 API，避免外部直接改狀態造成混亂
  return {
    uploadSceneToCloud,
    status,
    resetStatus,
    currentSceneId,
    clearCurrentScene,
    lastConflict,
    clearLastConflict,
  } as const;
}
