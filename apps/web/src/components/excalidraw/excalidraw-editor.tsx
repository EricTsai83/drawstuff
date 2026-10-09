"use client";

import {
  ExcalidrawCanvas,
  ExcalidrawDefaultSidebar,
  ExcalidrawFooter as Footer,
} from "@drawstuff/excalidraw-adapter/client";
import { LibraryBig } from "lucide-react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { toSyncedElements } from "@/lib/collab/element-bridge";
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
import {
  useSignedOutDraft,
  type AuthState,
} from "@/hooks/excalidraw/use-signed-out-draft";
import { useSignedOutRoomPrompt } from "@/hooks/excalidraw/use-signed-out-room-prompt";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  createEmbedUrlValidator,
  EXTRA_EMBED_DOMAINS,
} from "@/config/embed-allowlist";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { useSaveShortcut } from "@/hooks/excalidraw/use-save-shortcut";
import { EditorStorageStatus } from "./editor-storage-status";
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
  const {
    data: session,
    isPending: isAuthenticationPending,
    error: sessionError,
  } = authClient.useSession();
  // A failed session fetch keeps the last known session; only a definitive
  // answer (no session, or a 401) counts as signed out.
  const authState: AuthState = session
    ? "signed-in"
    : isAuthenticationPending || (sessionError && sessionError.status !== 401)
      ? "unknown"
      : "signed-out";
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
  const [isRoomInitializing, setIsRoomInitializing] = useState(false);
  const [isMobileCanvasSlot, setIsMobileCanvasSlot] = useState<boolean | null>(
    null,
  );
  const {
    handleUpdateSource,
    sourceConflictDialog,
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
    roomSaveState,
    sourceSceneId,
    requestRoomSave,
    confirmRoomExit,
    collaborationRoomId,
    setCollaborationRoomId,
    collaborationRoomKey,
    setCollaborationRoomKey,
    isRoomKeyLookupSettled,
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
    sceneChangeConfirm,
    handleSceneChange,
    cancelPendingSceneSave,
  });

  // A link without its key cannot join. Room's custody copy is asked for
  // first (plan 19); only when it has none does the dialog open so the person
  // can paste the complete invitation link.
  useEffect(() => {
    if (collaborationStatus === "missing-room-key" && isRoomKeyLookupSettled)
      openCollaborationDialog();
  }, [collaborationStatus, isRoomKeyLookupSettled, openCollaborationDialog]);
  useSignedOutRoomPrompt({
    authState,
    roomId: collaborationRoomId,
    openDialog: openCollaborationDialog,
  });

  const isRoomMode = !!collaborationRoomId || isCanvasOwnedByRoom;
  useSaveShortcut({
    enabled: !!session,
    onSave: isRoomMode ? requestRoomSave : handleCloudUpload,
  });

  const {
    needsDecision: hasSignedOutDraft,
    detachedFromSceneName,
    observeCanvas: observeSignedOutDraft,
    keepSignedOutDraft,
    discardSignedOutDraft,
  } = useSignedOutDraft({
    excalidrawAPI,
    authState,
    isRoomMode,
    hasCurrentCanvasContent,
  });
  const handleEditorChange = useCallback<typeof handleCanvasChange>(
    (elements, appState, files) => {
      handleCanvasChange(elements, appState, files);
      observeSignedOutDraft(elements);
    },
    [handleCanvasChange, observeSignedOutDraft],
  );

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
        isReadOnly: isCollaborationReadOnly || isRoomInitializing,
        onActivate: openCollaborationDialog,
      },
      cloudSave: session
        ? {
            statusLabel: isRoomMode
              ? t(`storage.room.${roomSaveState.status}`)
              : undefined,
            label: t(isRoomMode ? "storage.saveRoom" : "storage.savePersonal"),
            status: isRoomMode
              ? roomSaveState.status === "saving"
                ? "uploading"
                : roomSaveState.status === "saved"
                  ? "success"
                  : roomSaveState.status === "failed"
                    ? "error"
                    : "idle"
              : uploadStatus,
            // The room badge owns room save status; a second pill would
            // repeat it and, unlike a personal save, never reset.
            showStatusBadge: !isRoomMode,
            onActivate: isRoomMode
              ? requestRoomSave
              : () => void handleCloudUpload(),
          }
        : null,
      share: {
        status: exportStatus,
        onActivate: () => void handleShareLinkClick(),
      },
    }),
    [
      collaborationStatus,
      isRoomMode,
      roomSaveState.status,
      requestRoomSave,
      t,
      exportStatus,
      handleCloudUpload,
      handleShareLinkClick,
      isCollaborationReadOnly,
      isRoomInitializing,
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

  const storageStatusProps = useMemo(
    () => ({
      roomId: isRoomMode ? collaborationRoomId : null,
      state: roomSaveState,
      sourceSceneId,
      onRetry: requestRoomSave,
      onCopy: openCloudUploadDialog,
      onUpdateSource: handleUpdateSource,
      onExit: () => {
        if (!confirmRoomExit()) return;
        void setCollaborationRoomId(null);
        setCollaborationRoomKey(null);
      },
      api: excalidrawAPI,
      isAuthenticated: !!session,
      detachedFromSceneName,
    }),
    [
      isRoomMode,
      collaborationRoomId,
      roomSaveState,
      sourceSceneId,
      requestRoomSave,
      openCloudUploadDialog,
      handleUpdateSource,
      confirmRoomExit,
      setCollaborationRoomId,
      setCollaborationRoomKey,
      excalidrawAPI,
      session,
      detachedFromSceneName,
    ],
  );

  const renderTopRightUI = useCallback(
    (isMobile: boolean, _appState: UIAppState) => {
      return (
        <TopRightControls
          actions={productActions}
          storageStatus={
            <EditorStorageStatus {...storageStatusProps} compact />
          }
          isMobile={isMobile}
          onLibraryActivate={handleLibraryToggle}
          onSlotChange={setIsMobileCanvasSlot}
        />
      );
    },
    [handleLibraryToggle, productActions, storageStatusProps],
  );

  return (
    <div className="flex h-dvh w-full flex-col">
      <div className="min-h-0 flex-1">
        {initialDataPromise && (
          <ExcalidrawCanvas
            excalidrawAPI={excalidrawRefCallback}
            initialData={initialDataPromise}
            onChange={handleEditorChange}
            onPointerUpdate={handleCollabPointerUpdate}
            // 跟隨模式:上游負責 UI(點頭像、紫色外框),這裡把自己的視角廣播給
            // 跟隨者;「自己開始/停止跟隨」走 imperative API 訂閱(room-session)。
            onScrollChange={handleCollabScrollChange}
            isCollaborating={isCollaborating}
            // Viewer 角色在 UI 也是唯讀；server 端仍是唯一的權限來源。
            viewModeEnabled={isCollaborationReadOnly || isRoomInitializing}
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
              isCollaborating={isRoomMode}
              cancelPendingSceneSave={cancelPendingSceneSave}
              productActions={productActions}
              compactPresentation={isMobileCanvasSlot !== false}
              storageStatus={<EditorStorageStatus {...storageStatusProps} />}
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
              remoteConflict={
                sourceConflictDialog.open
                  ? sourceConflictDialog
                  : conflictDialog
              }
              collaboration={{
                open: isCollaborationDialogOpen,
                onOpenChange: setIsCollaborationDialogOpen,
                isAuthenticated: !!session,
                authIdentity: session?.user.id ?? null,
                isAuthenticationPending,
                sceneId: currentSceneId ?? null,
                getInitialElements: () =>
                  excalidrawAPI
                    ? toSyncedElements(
                        excalidrawAPI.getSceneElementsIncludingDeleted(),
                      )
                    : null,
                getInitialFiles: () =>
                  Object.values(excalidrawAPI?.getFiles() ?? {}),
                onInitializationChange: setIsRoomInitializing,
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
                confirmRoomExit,
              }}
              cloudUpload={{
                isRoom: isRoomMode,
                open: isCloudUploadDialogOpen,
                onOpenChange: setIsCloudUploadDialogOpen,
                onConfirm: handleCloudUploadConfirm,
              }}
              signedOutDraft={{
                // Hidden while the save it led to is in progress; reappears if
                // that save is cancelled or fails.
                open:
                  hasSignedOutDraft &&
                  !isCloudUploadDialogOpen &&
                  uploadStatus !== "uploading",
                detachedFromSceneName,
                onChoose: (choice) => {
                  if (choice === "save") openCloudUploadDialog();
                  else if (choice === "keep") keepSignedOutDraft();
                  else discardSignedOutDraft();
                },
              }}
            />
          </ExcalidrawCanvas>
        )}
      </div>
    </div>
  );
}
