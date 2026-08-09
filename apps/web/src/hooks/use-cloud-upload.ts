"use client";

import { useCallback, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-button";
import { api } from "@/trpc/react";
import {
  cleanupSceneAssetUploadsAction,
  createSceneDraftAction,
  readSceneAssetFileIdsAction,
  saveSceneAction,
} from "@/server/actions";
import { stringToBase64, toByteString } from "@/lib/encode";
import { normalizeToArrayBuffer } from "@/lib/array-buffer";
import {
  getCurrentSceneSnapshot,
  exportSceneThumbnail,
} from "@/lib/excalidraw";
import { prepareSceneDataForExport } from "@/lib/export-scene-to-backend";
import { useUploadThing } from "@/lib/uploadthing";
import type { NonDeletedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import { toast } from "sonner";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { APP_ERROR } from "@/lib/errors";
import { getSceneMetaBySceneId } from "@/lib/import-data-from-db";

export type SceneConflictInfo = {
  sceneId: string;
  remoteRevision?: number;
};

function getUploadedFileKey(uploaded: unknown): string | undefined {
  if (typeof uploaded !== "object" || uploaded === null) {
    return undefined;
  }

  const item = uploaded as {
    key?: unknown;
    serverData?: { fileKey?: unknown };
  };
  const serverFileKey = item.serverData?.fileKey;
  if (typeof serverFileKey === "string" && serverFileKey.length > 0) {
    return serverFileKey;
  }
  return typeof item.key === "string" && item.key.length > 0
    ? item.key
    : undefined;
}

function assertSingleUploadResult(
  uploadResult: unknown,
  label: string,
): string {
  if (!Array.isArray(uploadResult) || uploadResult.length !== 1) {
    throw new Error(`${label} upload did not return exactly one file`);
  }

  const fileKey = getUploadedFileKey(uploadResult[0]);
  if (!fileKey) {
    throw new Error(`${label} upload did not return a file key`);
  }

  return fileKey;
}

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
            { encrypt: false, profile: "owned-scene" },
          );
          const base64Data = stringToBase64(
            toByteString(prepared.compressedSceneData),
            true,
          );
          const safeNameFromState =
            (appState.name ?? t("labels.untitled")).trim() ||
            t("labels.untitled");

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
              toast.error(t("toast.scene.versionCheckFailed"));
              return false;
            }
          }

          // 優先使用呼叫端顯式傳入的 workspaceId（例如首次上傳 Dialog），
          // 其次使用 session 記錄的場景所屬 workspaceId
          const effectiveWorkspaceId =
            options?.workspaceId ?? currentWorkspaceIdRef.current;
          if (!effectiveWorkspaceId) {
            setStatus("error");
            toast.error(t("toast.workspace.required"));
            return false;
          }

          // 上傳壓縮檔案（不加密），與 sceneId 關聯。Excalidraw file id 隨上傳
          // input 顯式帶出，不再藏在檔名裡——檔名不是身份。
          const filesToUpload: Array<{
            file: File;
            excalidrawFileId: string;
          }> = prepared.compressedFilesData.map((f) => {
            const bufferForFile = normalizeToArrayBuffer(f.buffer);
            return {
              file: new File([bufferForFile], "asset", {
                type: "application/octet-stream",
              }),
              excalidrawFileId: f.id,
            };
          });

          const sceneName = options?.name ?? safeNameFromState;
          const sceneDescription = options?.description ?? "";
          const createdNewScene = effectiveSceneId === undefined;
          let targetSceneId = effectiveSceneId;
          let expectedRevision = lastSyncedRevisionRef.current;

          if (!targetSceneId) {
            const draftResult = await createSceneDraftAction({
              name: sceneName,
              description: sceneDescription,
              workspaceId: effectiveWorkspaceId,
            });

            if (!draftResult.ok) {
              throw new Error(draftResult.message ?? draftResult.error);
            }

            targetSceneId = draftResult.data.id;
            expectedRevision = draftResult.data.revision;
          }

          if (!targetSceneId || expectedRevision === undefined) {
            throw new Error("Unable to prepare scene upload target");
          }
          const sceneIdForCommit = targetSceneId;
          const expectedRevisionForCommit = expectedRevision;

          const rollbackCreatedDraft = async () => {
            if (!createdNewScene) {
              return;
            }
            try {
              await deleteSceneAsync({ id: sceneIdForCommit });
            } catch (rollbackErr) {
              console.error(
                "Failed to rollback newly-created scene draft:",
                rollbackErr,
              );
            }
          };

          const cleanupUploadedAssetKeys = async (fileKeys: string[]) => {
            if (fileKeys.length === 0) {
              return;
            }
            try {
              await cleanupSceneAssetUploadsAction({
                sceneId: sceneIdForCommit,
                fileKeys,
              });
            } catch (cleanupErr) {
              console.error(
                "Failed to cleanup uploaded scene assets:",
                cleanupErr,
              );
            }
          };

          const uploadedAssetKeys: string[] = [];

          const uploadAssetFiles = async (
            files: typeof filesToUpload,
          ): Promise<boolean> => {
            if (files.length === 0) {
              return true;
            }
            const perFileUploads = files.map(
              async ({ file, excalidrawFileId }) => {
                const buf = await file.arrayBuffer();
                const digest = await crypto.subtle.digest("SHA-256", buf);
                const hashArray = Array.from(new Uint8Array(digest));
                const contentHash = hashArray
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("");
                const uploadResult = await assetUpload.startUpload([file], {
                  sceneId: sceneIdForCommit,
                  excalidrawFileId,
                  contentHash,
                });
                return assertSingleUploadResult(
                  uploadResult,
                  `Asset ${excalidrawFileId}`,
                );
              },
            );

            const settledUploads = await Promise.allSettled(perFileUploads);
            for (const entry of settledUploads) {
              if (entry.status === "fulfilled") {
                uploadedAssetKeys.push(entry.value);
              }
            }

            const failedUpload = settledUploads.find(
              (entry): entry is PromiseRejectedResult =>
                entry.status === "rejected",
            );
            if (failedUpload) {
              console.error(
                "Asset upload failed before scene save:",
                failedUpload.reason,
              );
              return false;
            }
            return true;
          };

          // 只上傳這個場景還沒有的資產：既有場景先取一次已存的 file id 集合，
          // 同一張圖重複存檔就不再產生「上傳 → 伺服器以身份衝突拒絕 → 刪除剛
          // 上傳的物件」的往返。查詢失敗就退回全部上傳——伺服器端的身份唯一
          // 性仍把重複當重試拒絕，只是多花流量。
          let existingFileIds = new Set<string>();
          if (!createdNewScene && filesToUpload.length > 0) {
            try {
              const assetState = await readSceneAssetFileIdsAction({
                sceneId: sceneIdForCommit,
              });
              if (assetState.ok) {
                existingFileIds = new Set(assetState.fileIds);
              }
            } catch (stateErr) {
              console.error("Failed to read stored scene assets:", stateErr);
            }
          }

          const filesMissingOnScene = filesToUpload.filter(
            ({ excalidrawFileId }) => !existingFileIds.has(excalidrawFileId),
          );
          if (!(await uploadAssetFiles(filesMissingOnScene))) {
            markCurrentSceneDirty();
            await cleanupUploadedAssetKeys(uploadedAssetKeys);
            await rollbackCreatedDraft();
            setStatus("error");
            toast.error(t("app.cloudUpload.toast.error.upload"));
            return false;
          }

          const commitScene = async () =>
            await saveSceneAction({
              id: sceneIdForCommit,
              name: sceneName,
              description: sceneDescription,
              workspaceId: effectiveWorkspaceId,
              data: base64Data,
              categories: options?.categories,
              expectedRevision: expectedRevisionForCommit,
            });

          let result: Awaited<ReturnType<typeof saveSceneAction>>;
          try {
            result = await commitScene();

            if (!result.ok && result.error === APP_ERROR.SCENE_ASSETS_MISSING) {
              // 伺服器拒絕提交缺少資產紀錄的文件（紀錄可能被並發清理或 GC
              // 回收，或上面的 skip 讀到過期集合）。重新上傳缺少的資產後重試
              // 一次；再失敗則走一般失敗路徑，場景保持 dirty。
              const missingIds = new Set(result.missingFileIds ?? []);
              const retryFiles = filesToUpload.filter(({ excalidrawFileId }) =>
                missingIds.has(excalidrawFileId),
              );
              if (
                missingIds.size > 0 &&
                retryFiles.length === missingIds.size &&
                (await uploadAssetFiles(retryFiles))
              ) {
                result = await commitScene();
              }
            }
          } catch (saveErr) {
            markCurrentSceneDirty();
            await cleanupUploadedAssetKeys(uploadedAssetKeys);
            await rollbackCreatedDraft();
            throw saveErr;
          }

          if (!result.ok) {
            markCurrentSceneDirty();
            await cleanupUploadedAssetKeys(uploadedAssetKeys);
            await rollbackCreatedDraft();

            if (result.error === APP_ERROR.SCENE_NOT_FOUND) {
              if (!createdNewScene) {
                clearCurrentScene();
                onSceneNotFoundError();
              }
              setStatus("idle");
              return false;
            }
            if (result.error === APP_ERROR.SCENE_CONFLICT) {
              setStatus("idle");
              setLastConflict({
                sceneId: result.data?.id ?? sceneIdForCommit,
                remoteRevision: result.data?.revision,
              });
              return false;
            }
            throw new Error(result.message ?? result.error);
          }
          const { id, revision } = result.data;

          try {
            const pngBlob = await exportSceneThumbnail(
              elements as readonly NonDeletedExcalidrawElement[],
              appState,
              files,
            );
            const thumbnailFile = new File([pngBlob], "thumbnail.png", {
              type: "image/png",
            });
            const thumbnailResult = await thumbnailUpload.startUpload(
              [thumbnailFile],
              {
                sceneId: id,
              },
            );
            assertSingleUploadResult(thumbnailResult, "Thumbnail");
          } catch (thumbErr) {
            // 縮圖失敗不影響已完成的 scene + asset commit
            console.error(
              "Failed to generate/upload thumbnail after cloud upload:",
              thumbErr,
            );
          }

          syncCurrentScene({
            id: String(id),
            revision,
            workspaceId: effectiveWorkspaceId,
          });
          setStatus("success");

          // 可選地顯示成功 toast（由呼叫端統一顯示避免重複）
          if (!options?.suppressSuccessToast) {
            toast.success(t("app.cloudUpload.toast.success"));
          }

          // 完成雲端上傳後，讓清單失效以取得最新資料；
          // 上傳對話框可能新建分類，一併失效分類清單
          void utils.scene.getUserScenesInfinite.invalidate();
          void utils.category.list.invalidate();
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
