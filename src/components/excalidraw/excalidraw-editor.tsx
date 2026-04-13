"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, Footer } from "@excalidraw/excalidraw";
import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  UIAppState,
} from "@excalidraw/excalidraw/types";
import { useCallbackRefState } from "@/hooks/use-callback-ref-state";
import AppMainMenu from "./app-main-menu";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import AppWelcomeScreen from "./app-welcome-screen";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { createInitialDataPromise } from "@/lib/excalidraw";
import { SceneRenameDialog } from "@/components/excalidraw/scene-rename-dialog";
import CustomStats from "./custom-stats";
import { SceneNameTrigger } from "@/components/scene-name-trigger";
import { authClient } from "@/lib/auth/client";
import { useSceneExport } from "@/hooks/use-scene-export";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { useConfirmBeforeUnload } from "@/hooks/use-confirm-before-unload";
import type {
  NonDeletedExcalidrawElement,
  ExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import {
  ExportSceneActions,
  type ExportSceneActionsProps,
} from "./export-scene-actions";
import { closeExcalidrawDialog } from "@/lib/excalidraw";
import { TopRightControls } from "./top-right-controls";
import { SceneCloudUploadDialog } from "@/components/excalidraw/scene-cloud-upload-dialog";
import { OverwriteConfirmDialog } from "@/components/excalidraw/overwrite-confirm-dialog";
import { useFetchAndInjectSharedSceneFiles } from "@/hooks/excalidraw/use-fetch-and-inject-shared-scene-files";
import { useLanguagePreference } from "@/hooks/use-language-preference";
import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";
import { useExportHandlers } from "@/hooks/excalidraw/use-export-handlers";
import { EditorFooter } from "@/components/excalidraw/editor-footer";
import { useDashboardShortcut } from "@/hooks/use-dashboard-shortcut";
import { LOAD_SCENE_EVENT, type LoadSceneRequestDetail } from "@/lib/events";
import { SceneChangeConfirmDialog } from "./scene-change-confirm-dialog";
import { api } from "@/trpc/react";
import { useSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";
import { useLoadSceneWithConfirm } from "@/hooks/excalidraw/use-load-scene-with-confirm";
import { useWorkspaceCreateConfirm } from "@/hooks/use-workspace-create-confirm";
import GlobalConfirmDialog from "@/components/confirm-dialog";
import { useSceneImportFileGuard } from "@/hooks/excalidraw/use-scene-import-file-guard";
import { useApplyRemoteScene } from "@/hooks/excalidraw/use-apply-remote-scene";
import { useSceneRemoteRevisionCheck } from "@/hooks/excalidraw/use-scene-remote-revision-check";
import { SceneRemoteConflictDialog } from "@/components/excalidraw/scene-remote-conflict-dialog";
import { useSceneSession } from "@/hooks/scene-session-context";

export default function ExcalidrawEditor() {
  useSceneImportFileGuard();
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const { userChosenTheme, setTheme, browserActiveTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
  const {
    reloadSceneSession,
    suppressDirtyTracking,
    resumeDirtyTracking,
    isSessionReady,
    updateLastSyncedRevision,
    currentWorkspaceId,
  } = useSceneSession();
  const [initialDataPromise, setInitialDataPromise] =
    useState<Promise<ExcalidrawInitialDataState | null> | null>(null);
  const { data: session } = authClient.useSession();
  // 只在編輯器中、且使用者已登入時啟用 Dashboard 快捷鍵
  useDashboardShortcut(!!session);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const {
    exportScene,
    exportStatus,
    exportErrorMessage,
    latestShareableLink,
    resetExportStatus,
  } = useSceneExport();
  const { sceneName, handleSceneChange, handleSetSceneName } =
    useScenePersistence(excalidrawAPI);
  const {
    status: uploadStatus,
    uploadSceneToCloud,
    resetStatus,
    currentSceneId,
    clearCurrentScene,
    lastConflict,
    clearLastConflict,
  } = useCloudUpload(() => {
    setIsCloudUploadDialogOpen(true);
  }, excalidrawAPI);
  const { applyRemoteScene } = useApplyRemoteScene(excalidrawAPI);
  const [isCloudUploadDialogOpen, setIsCloudUploadDialogOpen] = useState(false);
  const { langCode, handleLangCodeChange } = useLanguagePreference();
  const setLastActiveMutation = api.workspace.setLastActive.useMutation();
  const utils = api.useUtils();
  const renameSceneMutation = api.scene.renameScene.useMutation();
  // 取得換場景確認 Dialog 控制方法（語意清楚的鍵名）
  const {
    isSceneChangeDialogOpen,
    isSceneChangeDialogLoading,
    handleSceneChangeDialogOpenChange,
    requestSceneChangeDecision,
    resolveSceneChangeDecision,
    setSceneChangeDialogLoading,
    closeSceneChangeDialog,
  } = useSceneChangeConfirm();

  // 當雲端上傳進行中時，阻止關閉視窗/重整，直到使用者確認
  useConfirmBeforeUnload(uploadStatus === "uploading");

  const {
    workspaceCreateConfirmOpen,
    setWorkspaceCreateConfirmOpen,
    workspaceCreateConfirmLoading,
    workspaceCreateConfirmOptions,
    showWorkspaceCreateConfirm,
  } = useWorkspaceCreateConfirm();

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
      setTimeout(() => setIsShareDialogOpen(true), 200);
    },
    isExporting: exportStatus === "exporting",
    isUploading: uploadStatus === "uploading",
    excalidrawAPI,
  });

  const renderCustomStats = useCallback(function renderCustomStats() {
    return <CustomStats />;
  }, []);

  useEffect(() => {
    // 註冊 handler 後再建立 initialDataPromise，避免 race
    suppressDirtyTracking();
    const nextInitialDataPromise = createInitialDataPromise();
    setInitialDataPromise(nextInitialDataPromise);
    void nextInitialDataPromise.finally(() => {
      try {
        reloadSceneSession();
      } finally {
        // Excalidraw may fire onChange after receiving initialData;
        // resume after a frame so those events don't mark dirty.
        // Placed in finally so suppression never leaks if reload throws.
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    });
  }, [reloadSceneSession, suppressDirtyTracking, resumeDirtyTracking]);

  // 解析分享資訊、取檔並注入 Excalidraw
  useFetchAndInjectSharedSceneFiles(excalidrawAPI);

  // 建立帶確認的載入動作
  const { loadSceneWithConfirm } = useLoadSceneWithConfirm({
    hasCurrentContent: () => {
      const els =
        (excalidrawAPI?.getSceneElements() as readonly ExcalidrawElement[]) ??
        [];
      return Array.isArray(els)
        ? els.some((el: ExcalidrawElement) => !el.isDeleted)
        : false;
    },
    requestSceneChangeDecision,
    setSceneChangeLoading: setSceneChangeDialogLoading,
    closeSceneChangeConfirm: closeSceneChangeDialog,
    uploadSceneToCloud,
    setLastActive: async (workspaceId: string) => {
      await setLastActiveMutation.mutateAsync({ workspaceId });
    },
    invalidate: async () => {
      try {
        await Promise.all([
          utils.workspace.listWithMeta.invalidate(),
          utils.scene.getUserScenesInfinite.invalidate(),
        ]);
      } catch {
        // ignore
      }
    },
    applyRemoteScene,
    getActiveTheme: () => browserActiveTheme,
  });

  const { conflictDialog } = useSceneRemoteRevisionCheck({
    applyRemoteScene,
    uploadSceneToCloud,
    getActiveTheme: () => browserActiveTheme,
    workspaceId: currentWorkspaceId,
    isReady: !!excalidrawAPI && isSessionReady,
    isUploadInProgress: uploadStatus === "uploading",
    isBlockingDialogOpen:
      isSceneChangeDialogOpen || isCloudUploadDialogOpen || workspaceCreateConfirmOpen,
    externalConflict: lastConflict,
    onExternalConflictHandled: clearLastConflict,
  });

  // 處理從 Dashboard 雙擊卡片觸發的載入事件（事件驅動，不用 URL hash）
  useEffect(() => {
    function onLoadSceneEvent(ev: Event): void {
      const e = ev as CustomEvent<LoadSceneRequestDetail>;
      if (!e?.detail?.sceneId) return;
      void loadSceneWithConfirm({
        sceneId: e.detail.sceneId,
        workspaceId: e.detail.workspaceId,
      });
    }

    window.addEventListener(
      LOAD_SCENE_EVENT,
      onLoadSceneEvent as EventListener,
    );
    return () =>
      window.removeEventListener(
        LOAD_SCENE_EVENT,
        onLoadSceneEvent as EventListener,
      );
  }, [loadSceneWithConfirm]);

  useEffect(() => {
    if (!lastConflict) return;
    closeSceneChangeDialog();
  }, [lastConflict, closeSceneChangeDialog]);

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
      session,
    ],
  );

  const handleCloudUpload = useCallback(async (): Promise<void> => {
    // 若尚未儲存過，先開啟命名/標籤/描述 Dialog
    if (!currentSceneId) {
      setIsCloudUploadDialogOpen(true);
      return;
    }
    await uploadSceneToCloud({ workspaceId: currentWorkspaceId });
  }, [uploadSceneToCloud, currentSceneId, currentWorkspaceId]);

  useEffect(() => {
    if (!session) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.isComposing || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s" && event.code !== "KeyS") return;

      // 攔截瀏覽器原生儲存快捷鍵，改走專案的雲端儲存流程。
      event.preventDefault();
      event.stopPropagation();
      void handleCloudUpload();
    }

    // 用 capture phase 盡量比瀏覽器/元件內部快捷鍵更早接手 Cmd/Ctrl+S。
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [session, handleCloudUpload]);

  useEffect(() => {
    if (uploadStatus === "success") {
      const timer = setTimeout(() => {
        resetStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (uploadStatus === "error") {
      toast.error("Failed to upload to cloud. Please try again.");
      const timer = setTimeout(() => {
        resetStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    return;
  }, [uploadStatus, resetStatus]);

  useEffect(() => {
    // 同步 Excalidraw appState.theme 與目前主題，避免載入/初始狀態殘留舊主題
    if (!excalidrawAPI) return;
    const current = excalidrawAPI.getAppState();
    if (current && current.theme !== browserActiveTheme) {
      excalidrawAPI.updateScene({
        appState: { ...current, theme: browserActiveTheme },
      });
    }
  }, [excalidrawAPI, browserActiveTheme]);

  useEffect(() => {
    if (exportStatus === "success") {
      const timer = setTimeout(() => {
        resetExportStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (exportStatus === "error") {
      const message =
        typeof exportErrorMessage === "string"
          ? exportErrorMessage
          : "Failed to export scene. Please try again.";
      toast.error(message);
      const timer = setTimeout(() => {
        resetExportStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    return;
  }, [exportStatus, exportErrorMessage, resetExportStatus]);

  const handleShareLinkClick = useCallback(async (): Promise<void> => {
    await handleExportLink();
  }, [handleExportLink]);

  const renderTopRightUI = useCallback(
    (isMobile: boolean, _appState: UIAppState) => {
      if (isMobile) return null;
      return (
        <TopRightControls
          cloudUploadStatus={uploadStatus}
          linkExportStatus={exportStatus}
          onCloudUploadClick={handleCloudUpload}
          onShareLinkClick={handleShareLinkClick}
        />
      );
    },
    [exportStatus, uploadStatus, handleCloudUpload, handleShareLinkClick],
  );

  return (
    <div className="h-dvh w-full">
      <GlobalConfirmDialog
        open={workspaceCreateConfirmOpen}
        onOpenChange={setWorkspaceCreateConfirmOpen}
        loading={workspaceCreateConfirmLoading}
        options={workspaceCreateConfirmOptions}
      />
      {initialDataPromise && (
        <Excalidraw
          excalidrawAPI={excalidrawRefCallback}
          initialData={initialDataPromise}
          onChange={handleSceneChange}
          UIOptions={{
            canvasActions: {
              toggleTheme: true,
              export: {
                saveFileToDisk: false, // 移除預設的「儲存到磁碟」按鈕
                renderCustomUI: renderCustomUiForExport,
              },
            },
          }}
          langCode={langCode}
          theme={browserActiveTheme}
          renderTopRightUI={renderTopRightUI}
          renderCustomStats={renderCustomStats}
        >
          <AppMainMenu
            userChosenTheme={userChosenTheme}
            setTheme={setTheme}
            langCode={langCode}
            onLangCodeChange={handleLangCodeChange}
            excalidrawAPI={excalidrawAPI}
            handleSetSceneName={handleSetSceneName}
            sceneName={sceneName}
            showConfirmDialog={showWorkspaceCreateConfirm}
          />

          <SceneRenameDialog
            excalidrawAPI={excalidrawAPI}
            trigger={<SceneNameTrigger sceneName={sceneName} />}
            onConfirmName={(newName) => {
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
                    onError: () =>
                      toast.error(
                        "Failed to update scene name. Please try again.",
                      ),
                  },
                );
              }
            }}
          />

          <Footer>
            <EditorFooter
              showDashboardShortcut={!!session}
              latestShareableLink={latestShareableLink}
              isShareDialogOpen={isShareDialogOpen}
              onShareDialogOpenChange={setIsShareDialogOpen}
            />
          </Footer>

          <AppWelcomeScreen />
          <SceneChangeConfirmDialog
            open={isSceneChangeDialogOpen}
            onOpenChange={handleSceneChangeDialogOpenChange}
            onChoose={resolveSceneChangeDecision}
            isLoading={Boolean(isSceneChangeDialogLoading)}
          />
          <OverwriteConfirmDialog
            excalidrawAPI={excalidrawAPI}
            clearCurrentSceneId={clearCurrentScene}
            onSceneNotFoundError={() => {
              setIsCloudUploadDialogOpen(true);
            }}
          />
          <SceneRemoteConflictDialog {...conflictDialog} />
          <SceneCloudUploadDialog
            open={isCloudUploadDialogOpen}
            onOpenChange={setIsCloudUploadDialogOpen}
            excalidrawAPI={excalidrawAPI}
            onConfirm={({
              name,
              description,
              categories,
              workspaceId,
            }: {
              name: string;
              description: string;
              categories: string[];
              workspaceId?: string;
            }) => {
              // 先把名稱寫回 Excalidraw appState（透過既有 helper）
              handleSetSceneName(name);
              void uploadSceneToCloud({
                name,
                description,
                categories,
                workspaceId,
              });
            }}
          />
        </Excalidraw>
      )}
    </div>
  );
}
