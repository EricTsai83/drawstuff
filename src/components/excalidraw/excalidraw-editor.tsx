"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, Footer } from "@excalidraw/excalidraw";
import { useState, useCallback, useEffect } from "react";
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
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  ExportSceneActions,
  type ExportSceneActionsProps,
} from "./export-scene-actions";
import {
  closeExcalidrawDialog,
  getCurrentSceneSnapshot,
} from "@/lib/excalidraw";
import { TopRightControls } from "./top-right-controls";
import { OverwriteConfirmDialog } from "@/components/excalidraw/overwrite-confirm-dialog";
import { useFetchAndInjectSharedSceneFiles } from "@/hooks/excalidraw/use-fetch-and-inject-shared-scene-files";
import { useLanguagePreference } from "@/hooks/use-language-preference";
import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";
import { useExportHandlers } from "@/hooks/excalidraw/use-export-handlers";
import { EditorFooter } from "@/components/excalidraw/editor-footer";

export default function ExcalidrawEditor() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const { userChosenTheme, setTheme, browserActiveTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
  const [initialDataPromise, setInitialDataPromise] =
    useState<Promise<ExcalidrawInitialDataState | null> | null>(null);
  const { data: session } = authClient.useSession();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const { exportScene, exportStatus, latestShareableLink } = useSceneExport();
  const {
    status: uploadStatus,
    uploadSceneToCloud,
    resetStatus,
  } = useCloudUpload();
  const { langCode, handleLangCodeChange } = useLanguagePreference();
  const { sceneName, handleSceneChange, handleSetSceneName } =
    useScenePersistence(excalidrawAPI);

  const { handleSaveToDisk, handleCloudUpload, handleExportLink } =
    useExportHandlers({
      exportScene,
      uploadSceneToCloud,
      onShareSuccess: () => {
        closeExcalidrawDialog(excalidrawAPI);
        setTimeout(() => setIsShareDialogOpen(true), 200);
      },
      isExporting: exportStatus === "exporting",
      isUploading: uploadStatus === "uploading",
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

  const renderCustomExportUI = useCallback(
    function renderCustomExportUI(
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
      _canvas: unknown,
    ) {
      const handlers: ExportSceneActionsProps["handlers"] = {
        handleSaveToDisk,
        handleCloudUpload,
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
      handleCloudUpload,
      handleExportLink,
      uploadStatus,
      exportStatus,
    ],
  );

  const handleRetry = useCallback(
    async function handleRetry(): Promise<void> {
      const scene = getCurrentSceneSnapshot(excalidrawAPI);
      if (!scene) return;
      try {
        await uploadSceneToCloud(
          scene.elements as readonly NonDeletedExcalidrawElement[],
          scene.appState,
          scene.files,
        );
      } catch {
        // 已在 hook 內處理狀態
      }
    },
    [uploadSceneToCloud, excalidrawAPI],
  );

  const handleSuccess = useCallback(
    function handleSuccess(): void {
      resetStatus();
    },
    [resetStatus],
  );

  const handleShareClick = useCallback(
    async function handleShareClick(): Promise<void> {
      const scene = getCurrentSceneSnapshot(excalidrawAPI);
      if (!scene) return;
      await handleExportLink(
        scene.elements as readonly NonDeletedExcalidrawElement[],
        scene.appState,
        scene.files,
      );
    },
    [handleExportLink, excalidrawAPI],
  );

  const renderTopRightUI = useCallback(
    (isMobile: boolean, _appState: UIAppState) => {
      if (isMobile) return null;
      return (
        <TopRightControls
          exportStatus={exportStatus}
          uploadStatus={uploadStatus}
          onClick={handleRetry}
          onSuccess={handleSuccess}
          onShareClick={handleShareClick}
        />
      );
    },
    [exportStatus, uploadStatus, handleRetry, handleSuccess, handleShareClick],
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
                renderCustomUI: renderCustomExportUI,
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
          <OverwriteConfirmDialog excalidrawAPI={excalidrawAPI} />
        </Excalidraw>
      )}
    </div>
  );
}
