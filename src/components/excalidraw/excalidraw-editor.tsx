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

export default function ExcalidrawEditor() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const { userChosenTheme, setTheme, browserActiveTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
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
    clearCurrentSceneId,
  } = useCloudUpload(() => {
    setIsCloudUploadDialogOpen(true);
  }, excalidrawAPI);
  const [isCloudUploadDialogOpen, setIsCloudUploadDialogOpen] = useState(false);
  const { langCode, handleLangCodeChange } = useLanguagePreference();

  const {
    handleSaveToDisk,
    handleCloudUpload: triggerCloudUpload,
    handleExportLink,
  } = useExportHandlers({
    exportScene,
    uploadSceneToCloud,
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

  useEffect(function initializeInitialDataPromise() {
    // 註冊 handler 後再建立 initialDataPromise，避免 race
    setInitialDataPromise(createInitialDataPromise());
  }, []);

  // 解析分享資訊、取檔並注入 Excalidraw
  useFetchAndInjectSharedSceneFiles(excalidrawAPI);

  // 初始掛載後置中（若有內容），避免首次渲染未置中的情況
  const [hasAutoCentered, setHasAutoCentered] = useState(false);
  useEffect(() => {
    if (!excalidrawAPI || hasAutoCentered) return;

    let attempts = 0;
    let timer: number | undefined;

    const tryCenter = () => {
      attempts += 1;
      const els =
        excalidrawAPI.getSceneElements() as readonly ExcalidrawElement[];
      const hasContent = Array.isArray(els)
        ? els.some((el: ExcalidrawElement) => !el.isDeleted)
        : false;

      if (hasContent) {
        // 使用官方 API 置中內容到視窗
        // https://docs.excalidraw.com/docs
        excalidrawAPI.scrollToContent(undefined, {
          fitToViewport: true,
          viewportZoomFactor: 0.7,
          animate: false,
        });
        setHasAutoCentered(true);
        return;
      }

      if (attempts < 10) {
        timer = window.setTimeout(tryCenter, 80);
      }
    };

    tryCenter();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [excalidrawAPI, hasAutoCentered]);

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
    ],
  );

  const handleCloudUpload = useCallback(async (): Promise<void> => {
    // 若尚未儲存過，先開啟命名/標籤/描述 Dialog
    if (!currentSceneId) {
      setIsCloudUploadDialogOpen(true);
      return;
    }
    await uploadSceneToCloud();
  }, [uploadSceneToCloud, currentSceneId]);

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
    <div className="h-screen w-screen">
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
            handleLangCodeChange={handleLangCodeChange}
            excalidrawAPI={excalidrawAPI}
            handleSetSceneName={handleSetSceneName}
          />

          <SceneRenameDialog
            excalidrawAPI={excalidrawAPI}
            trigger={<SceneNameTrigger sceneName={sceneName} />}
            onConfirmName={handleSetSceneName}
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
          <OverwriteConfirmDialog
            excalidrawAPI={excalidrawAPI}
            clearCurrentSceneId={clearCurrentSceneId}
            onSceneNotFoundError={() => {
              setIsCloudUploadDialogOpen(true);
            }}
          />
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
