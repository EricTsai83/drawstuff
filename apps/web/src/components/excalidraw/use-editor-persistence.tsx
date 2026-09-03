"use client";

/**
 * Composite hook for the editor's persistence surface: local scene
 * persistence, cloud save, share-link export, and the handlers the export
 * dialog, Main Menu, rename dialog and save shortcut call into. It groups the
 * hooks `ExcalidrawEditor` used to call one by one so the component reads as
 * composition; every handler is the one the component had.
 */

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  NonDeletedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { useConfirmBeforeUnload } from "@/hooks/use-confirm-before-unload";
import { useSceneExport } from "@/hooks/use-scene-export";
import { useEditorStatusToasts } from "@/hooks/excalidraw/use-editor-status-toasts";
import { useExportHandlers } from "@/hooks/excalidraw/use-export-handlers";
import { useSaveShortcut } from "@/hooks/excalidraw/use-save-shortcut";
import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";
import { closeExcalidrawDialog } from "@/lib/excalidraw";
import type { AuthSessionData } from "@/lib/types";
import { api } from "@/trpc/react";
import {
  ExportSceneActions,
  type ExportSceneActionsProps,
} from "./export-scene-actions";

export function useEditorPersistence(options: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  session: AuthSessionData;
  openCloudUploadDialog: () => void;
  setIsCloudUploadDialogOpen: (open: boolean) => void;
  setIsShareDialogOpen: (open: boolean) => void;
}) {
  const {
    excalidrawAPI,
    session,
    openCloudUploadDialog,
    setIsCloudUploadDialogOpen,
    setIsShareDialogOpen,
  } = options;
  const { t } = useAppI18n();
  const { currentWorkspaceId, updateLastSyncedRevision } = useSceneSession();
  const {
    exportScene,
    exportStatus,
    exportErrorMessage,
    latestShareableLink,
    resetExportStatus,
  } = useSceneExport();
  const {
    sceneName,
    handleSceneChange,
    handleSetSceneName,
    cancelPendingSceneSave,
  } = useScenePersistence(excalidrawAPI);
  const {
    status: uploadStatus,
    uploadSceneToCloud,
    resetStatus,
    currentSceneId,
    clearCurrentScene,
    lastConflict,
    clearLastConflict,
  } = useCloudUpload(openCloudUploadDialog, excalidrawAPI);
  const utils = api.useUtils();
  const renameSceneMutation = api.scene.renameScene.useMutation();

  // 當雲端上傳進行中時，阻止關閉視窗/重整，直到使用者確認
  useConfirmBeforeUnload(uploadStatus === "uploading");

  // 分享成功後延遲開啟對話框的計時器；unmount 時清除，避免對已卸載元件 setState
  const shareDialogTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(shareDialogTimerRef.current), []);

  const {
    handleSaveToDisk,
    handleCloudUpload: triggerCloudUpload,
    handleExportLink,
  } = useExportHandlers({
    exportScene,
    uploadSceneToCloud: () =>
      uploadSceneToCloud({ workspaceId: currentWorkspaceId }),
    onShareSuccess: () => {
      closeExcalidrawDialog(excalidrawAPI);
      clearTimeout(shareDialogTimerRef.current);
      shareDialogTimerRef.current = setTimeout(
        () => setIsShareDialogOpen(true),
        200,
      );
    },
    isExporting: exportStatus === "exporting",
    isUploading: uploadStatus === "uploading",
    excalidrawAPI,
  });

  const renderCustomUiForExport = useCallback(
    (
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
      _canvas: unknown,
    ) => {
      const handlers: ExportSceneActionsProps["handlers"] = {
        handleSaveToDisk,
        // 第一次需開 dialog 命名與標籤，之後直接儲存
        handleCloudUpload: (_els, _state, _files) => {
          if (!currentSceneId) {
            setIsCloudUploadDialogOpen(true);
            return;
          }
          return triggerCloudUpload();
        },
        handleExportLink,
      };

      return (
        <ExportSceneActions
          session={session}
          elements={elements}
          appState={appState}
          files={files}
          uploadStatus={uploadStatus}
          isLinkExporting={exportStatus === "exporting"}
          handlers={handlers}
        />
      );
    },
    [
      handleSaveToDisk,
      triggerCloudUpload,
      handleExportLink,
      uploadStatus,
      exportStatus,
      currentSceneId,
      setIsCloudUploadDialogOpen,
      session,
    ],
  );

  const handleCloudUpload = useCallback(async (): Promise<void> => {
    // 若尚未儲存過，先開啟命名/標籤/描述 Dialog
    if (!currentSceneId) {
      openCloudUploadDialog();
      return;
    }
    await uploadSceneToCloud({ workspaceId: currentWorkspaceId });
  }, [
    uploadSceneToCloud,
    currentSceneId,
    currentWorkspaceId,
    openCloudUploadDialog,
  ]);

  const handleCloudUploadConfirm = useCallback(
    (input: {
      name: string;
      description: string;
      categories: string[];
      workspaceId?: string;
    }) => {
      // 先把名稱寫回 Excalidraw appState（透過既有 helper）
      handleSetSceneName(input.name);
      void uploadSceneToCloud(input);
    },
    [handleSetSceneName, uploadSceneToCloud],
  );

  // 攔截瀏覽器原生儲存快捷鍵，改走專案的雲端儲存流程。
  useSaveShortcut({ enabled: !!session, onSave: handleCloudUpload });

  // 上傳／匯出狀態的短暫顯示與錯誤 toast。
  useEditorStatusToasts({
    uploadStatus,
    resetUploadStatus: resetStatus,
    exportStatus,
    exportErrorMessage,
    resetExportStatus,
  });

  const handleShareLinkClick = useCallback(async (): Promise<void> => {
    await handleExportLink();
  }, [handleExportLink]);

  // Was an inline arrow on `SceneRenameDialog`; deliberately not memoized so
  // the prop keeps the per-render identity it always had.
  const handleSceneRename = (newName: string): void => {
    // 先同步更新到 Excalidraw appState
    handleSetSceneName(newName);
    // 若已有雲端場景 ID，直接更新 DB 名稱
    if (currentSceneId) {
      renameSceneMutation.mutate(
        { id: currentSceneId, name: newName },
        {
          onSuccess: (data) => {
            void utils.scene.getUserScenesInfinite.invalidate();
            if (data.revision != null) {
              updateLastSyncedRevision(data.revision);
            }
          },
          onError: () => toast.error(t("errors.failedToUpdateSceneName")),
        },
      );
    }
  };

  return {
    sceneName,
    handleSceneChange,
    handleSetSceneName,
    cancelPendingSceneSave,
    uploadStatus,
    uploadSceneToCloud,
    currentSceneId,
    clearCurrentScene,
    lastConflict,
    clearLastConflict,
    exportStatus,
    latestShareableLink,
    renderCustomUiForExport,
    handleCloudUpload,
    handleCloudUploadConfirm,
    handleShareLinkClick,
    handleSceneRename,
  };
}
