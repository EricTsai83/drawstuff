"use client";

import {
  ExcalidrawCanvas,
  ExcalidrawFooter as Footer,
} from "@drawstuff/excalidraw-adapter/client";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  UIAppState,
} from "@drawstuff/excalidraw-adapter/types";
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
} from "@drawstuff/excalidraw-adapter/types";
import {
  ExportSceneActions,
  type ExportSceneActionsProps,
} from "./export-scene-actions";
import { closeExcalidrawDialog } from "@/lib/excalidraw";
import { TopRightControls } from "./top-right-controls";
import { EditorDialogs } from "@/components/excalidraw/editor-dialogs";
import { useFetchAndInjectSharedSceneFiles } from "@/hooks/excalidraw/use-fetch-and-inject-shared-scene-files";
import { useLanguagePreference } from "@/hooks/use-language-preference";
import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";
import { useExportHandlers } from "@/hooks/excalidraw/use-export-handlers";
import { EditorFooter } from "@/components/excalidraw/editor-footer";
import { useDashboardShortcut } from "@/hooks/use-dashboard-shortcut";
import { LOAD_SCENE_EVENT, type LoadSceneRequestDetail } from "@/lib/events";
import { api } from "@/trpc/react";
import { useCanvasHandoff } from "@/hooks/excalidraw/use-canvas-handoff";
import { useEditorDialogs } from "@/hooks/excalidraw/use-editor-dialogs";
import { useEditorStatusToasts } from "@/hooks/excalidraw/use-editor-status-toasts";
import { useSaveShortcut } from "@/hooks/excalidraw/use-save-shortcut";
import { useSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";
import { useLoadSceneWithConfirm } from "@/hooks/excalidraw/use-load-scene-with-confirm";
import { useWorkspaceCreateConfirm } from "@/hooks/use-workspace-create-confirm";
import GlobalConfirmDialog from "@/components/confirm-dialog";
import { useSceneImportFileGuard } from "@/hooks/excalidraw/use-scene-import-file-guard";
import { useApplyRemoteScene } from "@/hooks/excalidraw/use-apply-remote-scene";
import { useSceneRemoteRevisionCheck } from "@/hooks/excalidraw/use-scene-remote-revision-check";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  createEmbedUrlValidator,
  EXTRA_EMBED_DOMAINS,
} from "@/config/embed-allowlist";
import { useCollaborationRoom } from "@/hooks/excalidraw/use-collaboration-room";
import { useCollaborationRoomKey } from "@/hooks/excalidraw/use-collaboration-room-key";
import { COLLABORATION_ROOM_PARAM } from "@/lib/collab/room-link";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { PersonalLibraryController } from "@/components/excalidraw/personal-library-controller";
import { getCanonicalLibraryReturnUrl } from "@/lib/personal-library";
import { clearCanvasForWorkspaceDeletion } from "@/lib/workspace-deletion";
import type { CanvasProductActions } from "./canvas-product-actions";

// 只建立一次：命中補充名單才放行，其餘交回 upstream 內建白名單。
const embedUrlValidator = createEmbedUrlValidator(EXTRA_EMBED_DOMAINS);

export default function ExcalidrawEditor() {
  const { t } = useAppI18n();
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
    clearCurrentScene: clearSceneSession,
    registerCanvasLifecycle,
  } = useSceneSession();
  const [initialDataPromise, setInitialDataPromise] =
    useState<Promise<ExcalidrawInitialDataState | null> | null>(null);
  const { data: session, isPending: isAuthenticationPending } =
    authClient.useSession();
  const libraryIdentity = isAuthenticationPending
    ? "auth-pending"
    : session?.user.id
      ? `user:${session.user.id}`
      : "anonymous";
  // Canonicalization is pure string work on a URL that only changes with a
  // navigation, so one computation per mount is enough.
  const libraryReturnUrl = useMemo(
    () => getCanonicalLibraryReturnUrl(window.location.href),
    [],
  );
  // 只在編輯器中、且使用者已登入時啟用 Dashboard 快捷鍵
  useDashboardShortcut(!!session, currentWorkspaceId);
  const {
    isShareDialogOpen,
    setIsShareDialogOpen,
    isCollaborationDialogOpen,
    setIsCollaborationDialogOpen,
    openCollaborationDialog,
    isCloudUploadDialogOpen,
    setIsCloudUploadDialogOpen,
    openCloudUploadDialog,
  } = useEditorDialogs();
  const [isMobileCanvasSlot, setIsMobileCanvasSlot] = useState<boolean | null>(
    null,
  );
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
  const { applyRemoteScene } = useApplyRemoteScene(excalidrawAPI);
  // 共編 room：room id 放在 query string（連結即邀請，權限仍由後端決定），
  // 端到端金鑰只放在 URL fragment，永遠不會隨 request 送到伺服器。
  const [collaborationRoomId, setCollaborationRoomId] = useQueryState(
    COLLABORATION_ROOM_PARAM,
  );
  const [collaborationRoomKey, setCollaborationRoomKey] =
    useCollaborationRoomKey();
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

  // 畫布是否還有內容：加入共編前要用同一個判斷去問「未存內容要不要先存」。
  const hasCurrentCanvasContent = useCallback(() => {
    const elements =
      (excalidrawAPI?.getSceneElements() as readonly ExcalidrawElement[]) ?? [];
    return Array.isArray(elements)
      ? elements.some((element: ExcalidrawElement) => !element.isDeleted)
      : false;
  }, [excalidrawAPI]);

  // 加入不是自己場景的 room 時，先用既有的「儲存／捨棄／取消」流程換掉本地
  // 畫布；連線前完成，才不會有把無關場景廣播進 room 的窗口。room hook 只收
  // 這一個交接動作與它的取消入口，不再收六個零散 callback。
  const { prepareCanvasForRoom, cancelPendingCanvasDecision } =
    useCanvasHandoff({
      excalidrawAPI,
      hasLocalContent: hasCurrentCanvasContent,
      requestSceneChangeDecision,
      resolveSceneChangeDecision,
      closeSceneChangeConfirm: closeSceneChangeDialog,
      uploadSceneToCloud,
      clearCurrentScene,
    });

  const {
    status: collaborationStatus,
    failureReason: collaborationFailureReason,
    role: collaborationRole,
    isReadOnly: isCollaborationReadOnly,
    isCollaborating,
    errorMessage: collaborationErrorMessage,
    ownsCanvas: isCanvasOwnedByRoom,
    retryJoin: retryCollaborationJoin,
    onPointerUpdate: handleCollabPointerUpdate,
    onSceneChange: handleCollabSceneChange,
  } = useCollaborationRoom({
    excalidrawAPI,
    roomId: collaborationRoomId,
    roomKey: collaborationRoomKey,
    currentSceneId: currentSceneId ?? null,
    username: session?.user?.name,
    isAuthenticated: !!session,
    prepareCanvasForRoom,
    cancelPendingCanvasDecision,
  });

  useEffect(
    () =>
      registerCanvasLifecycle({
        isCollaborationActive: () => isCanvasOwnedByRoom,
        resetAfterWorkspaceDeletion: () =>
          clearCanvasForWorkspaceDeletion({
            excalidrawAPI: excalidrawAPI ?? null,
            cancelPendingSceneSave,
            clearCurrentScene: clearSceneSession,
            suppressDirtyTracking,
            resumeDirtyTracking,
          }),
      }),
    [
      cancelPendingSceneSave,
      clearSceneSession,
      excalidrawAPI,
      isCanvasOwnedByRoom,
      registerCanvasLifecycle,
      resumeDirtyTracking,
      suppressDirtyTracking,
    ],
  );
  const handleCanvasChange = useCallback<typeof handleSceneChange>(
    (elements, appState, files) => {
      handleSceneChange(elements, appState, files);
      handleCollabSceneChange(elements, appState);
    },
    [handleSceneChange, handleCollabSceneChange],
  );

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
    hasCurrentContent: hasCurrentCanvasContent,
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
    isReady: !!excalidrawAPI && isSessionReady && !!session,
    isUploadInProgress: uploadStatus === "uploading",
    isBlockingDialogOpen:
      isSceneChangeDialogOpen ||
      isCloudUploadDialogOpen ||
      workspaceCreateConfirmOpen,
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

  const handleShareLinkClick = useCallback(async (): Promise<void> => {
    await handleExportLink();
  }, [handleExportLink]);

  const productActions = useMemo<CanvasProductActions>(
    () => ({
      collaboration: {
        status: collaborationStatus,
        isReadOnly: isCollaborationReadOnly,
        onActivate: openCollaborationDialog,
      },
      cloudSave: session
        ? {
            status: uploadStatus,
            onActivate: () => void handleCloudUpload(),
          }
        : null,
      share: {
        status: exportStatus,
        onActivate: () => void handleShareLinkClick(),
      },
    }),
    [
      collaborationStatus,
      exportStatus,
      handleCloudUpload,
      handleShareLinkClick,
      isCollaborationReadOnly,
      openCollaborationDialog,
      session,
      uploadStatus,
    ],
  );

  const renderTopRightUI = useCallback(
    (isMobile: boolean, _appState: UIAppState) => {
      return (
        <TopRightControls
          actions={productActions}
          isMobile={isMobile}
          onSlotChange={setIsMobileCanvasSlot}
        />
      );
    },
    [productActions],
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
        <ExcalidrawCanvas
          excalidrawAPI={excalidrawRefCallback}
          initialData={initialDataPromise}
          onChange={handleCanvasChange}
          onPointerUpdate={handleCollabPointerUpdate}
          isCollaborating={isCollaborating}
          // Viewer 角色在 UI 也是唯讀；server 端仍是唯一的權限來源。
          viewModeEnabled={isCollaborationReadOnly}
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
          libraryReturnUrl={libraryReturnUrl}
          theme={browserActiveTheme}
          renderTopRightUI={renderTopRightUI}
          renderCustomStats={renderCustomStats}
          validateEmbeddable={embedUrlValidator}
        >
          <PersonalLibraryController
            key={libraryIdentity}
            excalidrawAPI={excalidrawAPI ?? null}
            userId={session?.user.id ?? null}
            isAuthenticationPending={isAuthenticationPending}
          />
          <AppMainMenu
            userChosenTheme={userChosenTheme}
            setTheme={setTheme}
            langCode={langCode}
            onLangCodeChange={handleLangCodeChange}
            excalidrawAPI={excalidrawAPI}
            handleSetSceneName={handleSetSceneName}
            sceneName={sceneName}
            showConfirmDialog={showWorkspaceCreateConfirm}
            isCollaborating={isCanvasOwnedByRoom}
            cancelPendingSceneSave={cancelPendingSceneSave}
            productActions={productActions}
            compactPresentation={isMobileCanvasSlot !== false}
          />

          <SceneRenameDialog
            excalidrawAPI={excalidrawAPI}
            trigger={
              <SceneNameTrigger
                sceneName={sceneName}
                isMobileSlot={isMobileCanvasSlot !== false}
              />
            }
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
                      toast.error(t("errors.failedToUpdateSceneName")),
                  },
                );
              }
            }}
          />

          <Footer>
            <EditorFooter
              showDesktopActions={isMobileCanvasSlot === false}
              showDashboardShortcut={!!session}
              latestShareableLink={latestShareableLink}
              isShareDialogOpen={isShareDialogOpen}
              onShareDialogOpenChange={setIsShareDialogOpen}
              workspaceId={currentWorkspaceId}
            />
          </Footer>

          <AppWelcomeScreen />
          <EditorDialogs
            excalidrawAPI={excalidrawAPI}
            sceneChange={{
              open: isSceneChangeDialogOpen,
              onOpenChange: handleSceneChangeDialogOpenChange,
              onChoose: resolveSceneChangeDecision,
              isLoading: Boolean(isSceneChangeDialogLoading),
            }}
            overwrite={{
              clearCurrentSceneId: clearCurrentScene,
              onSceneNotFoundError: openCloudUploadDialog,
            }}
            remoteConflict={conflictDialog}
            collaboration={{
              open: isCollaborationDialogOpen,
              onOpenChange: setIsCollaborationDialogOpen,
              isAuthenticated: !!session,
              isAuthenticationPending,
              sceneId: currentSceneId ?? null,
              roomId: collaborationRoomId,
              onRoomIdChange: (nextRoomId) => {
                void setCollaborationRoomId(nextRoomId);
              },
              roomKey: collaborationRoomKey,
              onRoomKeyChange: setCollaborationRoomKey,
              status: collaborationStatus,
              failureReason: collaborationFailureReason,
              role: collaborationRole,
              errorMessage: collaborationErrorMessage,
              onRetryJoin: retryCollaborationJoin,
            }}
            cloudUpload={{
              open: isCloudUploadDialogOpen,
              onOpenChange: setIsCloudUploadDialogOpen,
              onConfirm: handleCloudUploadConfirm,
            }}
          />
        </ExcalidrawCanvas>
      )}
    </div>
  );
}
