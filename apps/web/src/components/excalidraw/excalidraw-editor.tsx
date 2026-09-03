"use client";

import {
  ExcalidrawCanvas,
  ExcalidrawDefaultSidebar,
  ExcalidrawFooter as Footer,
} from "@drawstuff/excalidraw-adapter/client";
import { LibraryBig } from "lucide-react";
import { useState, useCallback, useMemo } from "react";
import type {
  ExcalidrawImperativeAPI,
  UIAppState,
} from "@drawstuff/excalidraw-adapter/types";
import { useCallbackRefState } from "@/hooks/use-callback-ref-state";
import AppMainMenu from "./app-main-menu";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import AppWelcomeScreen from "./app-welcome-screen";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { SceneRenameDialog } from "@/components/excalidraw/scene-rename-dialog";
import CustomStats from "./custom-stats";
import { SceneNameTrigger } from "@/components/scene-name-trigger";
import { authClient } from "@/lib/auth/client";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { TopRightControls } from "./top-right-controls";
import { EditorDialogs } from "@/components/excalidraw/editor-dialogs";
import { useLanguagePreference } from "@/hooks/use-language-preference";
import { EditorFooter } from "@/components/excalidraw/editor-footer";
import { useDashboardShortcut } from "@/hooks/use-dashboard-shortcut";
import { useEditorDialogs } from "@/hooks/excalidraw/use-editor-dialogs";
import { useSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";
import { useSceneImportFileGuard } from "@/hooks/excalidraw/use-scene-import-file-guard";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  createEmbedUrlValidator,
  EXTRA_EMBED_DOMAINS,
} from "@/config/embed-allowlist";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { PersonalLibraryController } from "@/components/excalidraw/personal-library-controller";
import { getCanonicalLibraryReturnUrl } from "@/lib/personal-library";
import type { CanvasProductActions } from "./canvas-product-actions";
import { useEditorCollaboration } from "./use-editor-collaboration";
import { useEditorPersistence } from "./use-editor-persistence";
import { useEditorSceneLoading } from "./use-editor-scene-loading";
import "./excalidraw-editor.module.css";

// 只建立一次：命中補充名單才放行，其餘交回 upstream 內建白名單。
const embedUrlValidator = createEmbedUrlValidator(EXTRA_EMBED_DOMAINS);

export default function ExcalidrawEditor() {
  const { t } = useAppI18n();
  useSceneImportFileGuard();
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const { userChosenTheme, setTheme, browserActiveTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
  const { currentWorkspaceId } = useSceneSession();
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
  } = useEditorPersistence({
    excalidrawAPI,
    session,
    openCloudUploadDialog,
    setIsCloudUploadDialogOpen,
    setIsShareDialogOpen,
  });
  const { langCode, handleLangCodeChange } = useLanguagePreference();
  const libraryLabel =
    t("canvas.actions.library") ||
    (langCode === "zh-TW" ? "素材庫" : "Library");
  // 取得換場景確認 Dialog 控制方法（語意清楚的鍵名）
  const sceneChangeConfirm = useSceneChangeConfirm();
  const {
    isSceneChangeDialogOpen,
    isSceneChangeDialogLoading,
    handleSceneChangeDialogOpenChange,
    resolveSceneChangeDecision,
  } = sceneChangeConfirm;

  // 畫布是否還有內容：加入共編前要用同一個判斷去問「未存內容要不要先存」。
  const hasCurrentCanvasContent = useCallback(() => {
    const elements =
      (excalidrawAPI?.getSceneElements() as readonly ExcalidrawElement[]) ?? [];
    return Array.isArray(elements)
      ? elements.some((element: ExcalidrawElement) => !element.isDeleted)
      : false;
  }, [excalidrawAPI]);

  const {
    collaborationRoomId,
    setCollaborationRoomId,
    collaborationRoomKey,
    setCollaborationRoomKey,
    collaborationStatus,
    collaborationFailureReason,
    collaborationRole,
    isCollaborationReadOnly,
    isCollaborating,
    collaborationErrorMessage,
    isCanvasOwnedByRoom,
    retryCollaborationJoin,
    handleCollabPointerUpdate,
    handleCollabScrollChange,
    handleCanvasChange,
  } = useEditorCollaboration({
    excalidrawAPI,
    session,
    currentSceneId,
    hasCurrentCanvasContent,
    uploadSceneToCloud,
    clearCurrentScene,
    sceneChangeConfirm,
    handleSceneChange,
    cancelPendingSceneSave,
  });

  const { initialDataPromise, conflictDialog } = useEditorSceneLoading({
    excalidrawAPI,
    session,
    browserActiveTheme,
    hasCurrentCanvasContent,
    sceneChangeConfirm,
    uploadSceneToCloud,
    uploadStatus,
    isCloudUploadDialogOpen,
    lastConflict,
    clearLastConflict,
  });

  const renderCustomStats = useCallback(function renderCustomStats() {
    return <CustomStats />;
  }, []);

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

  const handleLibraryToggle = useCallback(() => {
    if (!excalidrawAPI) return;
    const currentSidebar = excalidrawAPI.getAppState().openSidebar;
    const isLibraryOpen =
      currentSidebar?.name === "default" && currentSidebar.tab === "library";
    excalidrawAPI.updateScene({
      appState: {
        openSidebar: isLibraryOpen ? null : { name: "default", tab: "library" },
      },
    });
  }, [excalidrawAPI]);

  const renderTopRightUI = useCallback(
    (isMobile: boolean, _appState: UIAppState) => {
      return (
        <TopRightControls
          actions={productActions}
          isMobile={isMobile}
          onLibraryActivate={handleLibraryToggle}
          onSlotChange={setIsMobileCanvasSlot}
        />
      );
    },
    [handleLibraryToggle, productActions],
  );

  return (
    <div className="h-dvh w-full">
      {initialDataPromise && (
        <ExcalidrawCanvas
          excalidrawAPI={excalidrawRefCallback}
          initialData={initialDataPromise}
          onChange={handleCanvasChange}
          onPointerUpdate={handleCollabPointerUpdate}
          // 跟隨模式:上游負責 UI(點頭像、紫色外框),這裡把自己的視角廣播給
          // 跟隨者;「自己開始/停止跟隨」走 imperative API 訂閱(room-session)。
          onScrollChange={handleCollabScrollChange}
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
          <ExcalidrawDefaultSidebar.Trigger
            icon={<LibraryBig aria-hidden="true" />}
            tab="library"
            title={libraryLabel}
          >
            {libraryLabel}
          </ExcalidrawDefaultSidebar.Trigger>
          <AppMainMenu
            userChosenTheme={userChosenTheme}
            setTheme={setTheme}
            langCode={langCode}
            onLangCodeChange={handleLangCodeChange}
            excalidrawAPI={excalidrawAPI}
            handleSetSceneName={handleSetSceneName}
            sceneName={sceneName}
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
            onConfirmName={handleSceneRename}
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
