"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, Footer } from "@excalidraw/excalidraw";
import { useState, useCallback } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCallbackRefState } from "@/hooks/use-callback-ref-state";
import { useDebounce } from "@/hooks/use-debounce";
import { STORAGE_KEYS } from "@/config/app-constants";
import { getPreferredLanguage } from "./app-language/language-detector";
import AppMainMenu from "./app-main-menu";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import AppWelcomeScreen from "./app-welcome-screen";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { createInitialDataPromise, saveData } from "@/lib/excalidraw";
import { DrawingShareDialog } from "@/components/drawing-share-dialog";
import { DrawingRenameDialog } from "@/components/drawing-rename-dialog";
import { StorageWarning } from "@/components/storage-warning";
import CustomStats from "./custom-stats";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { PanelsTopLeft } from "lucide-react";
import { DrawingNameTrigger } from "@/components/drawing-name-trigger";
import { authClient } from "@/lib/auth/client";
import {
  CloudUploadStatus,
  type UploadStatus,
} from "@/components/excalidraw/cloud-upload-status";
import { useSceneExport } from "@/hooks/use-scene-export";
import { Button } from "@/components/ui/button";
import { Loader2, Share } from "lucide-react";
import { toast } from "sonner";

export default function ExcalidrawEditor() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const [sceneName, setSceneName] = useState("");
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang ?? getPreferredLanguage());
  const { userChosenTheme, setTheme, browserActiveTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
  const [debouncedSave] = useDebounce(saveData, 300);
  const [initialDataPromise] = useState(() => createInitialDataPromise());
  const { data: session } = authClient.useSession();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("pending");
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  // 使用場景導出 hook
  const { exportScene, exportStatus, latestShareableLink } = useSceneExport();

  const onChange = useCallback(
    (
      excalidrawElements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      const data = {
        elements: excalidrawElements,
        appState: appState,
        files: files,
      };

      // 更新名字狀態
      setSceneName(appState.name ?? "");

      debouncedSave(data);
    },
    [debouncedSave],
  );

  const handleLangCodeChange = useCallback((langCode: string) => {
    setLangCode(langCode);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, langCode);
  }, []);

  const renderCustomStats = useCallback(() => <CustomStats />, []);

  const handleRetry = () => {
    setUploadStatus("uploading");
    // 模擬上傳完成
    setTimeout(() => {
      setUploadStatus("success");
    }, 2000);
  };

  const handleSuccess = () => {
    setUploadStatus("idle");
  };

  // 根據 exportStatus 獲取按鈕配置
  const getShareButtonConfig = useCallback(() => {
    switch (exportStatus) {
      case "exporting":
        return {
          icon: <Loader2 className="h-4 w-4 animate-spin" />,
          text: "Exporting...",
          disabled: true,
          variant: "secondary" as const,
        };
      default:
        return {
          icon: <Share className="h-4 w-4" />,
          text: "Share",
          disabled: false,
          variant: "default" as const,
        };
    }
  }, [exportStatus]);

  const handleShareClick = useCallback(async () => {
    if (!excalidrawAPI) return;

    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();

    const shareableUrl = await exportScene(
      elements,
      appState as Partial<AppState>,
      files,
    );
    if (shareableUrl) {
      setIsShareDialogOpen(true);
    } else {
      toast.error("Failed to export scene. Please try again.");
    }
  }, [excalidrawAPI, exportScene]);

  const renderTopRightUI = (isMobile: boolean) => {
    const buttonConfig = getShareButtonConfig();

    return isMobile ? null : (
      <>
        <CloudUploadStatus
          status={uploadStatus}
          errorMessage="網路連線失敗"
          onClick={handleRetry}
          onSuccess={handleSuccess}
        />

        <Button
          className="flex items-center gap-2 font-normal"
          variant={buttonConfig.variant}
          disabled={buttonConfig.disabled}
          onClick={handleShareClick}
        >
          {buttonConfig.icon}
          {buttonConfig.text}
        </Button>
      </>
    );
  };

  return (
    <div className="h-screen w-screen">
      <Excalidraw
        excalidrawAPI={excalidrawRefCallback}
        initialData={initialDataPromise}
        onChange={onChange}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              saveFileToDisk: true,
              onExportToBackend: (elements, appState, files) => {
                void (async () => {
                  const shareableUrl = await exportScene(
                    elements,
                    appState as Partial<AppState>,
                    files,
                  );
                  if (shareableUrl) {
                    setIsShareDialogOpen(true);
                  } else {
                    toast.error("Failed to export scene. Please try again.");
                  }
                })();
              },
              // renderCustomUI: (elements, appState, files, canvas) => {
              //   return undefined;
              // },
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
        />

        <DrawingRenameDialog
          excalidrawAPI={excalidrawAPI}
          trigger={<DrawingNameTrigger sceneName={sceneName} />}
        />

        <Footer>
          <div className="ml-2.5 flex items-center gap-2.5">
            {session && (
              <Link href="/dashboard">
                <PanelsTopLeft
                  className={cn(
                    "flex h-9 w-9 cursor-pointer items-center justify-center rounded-full p-2",
                    "bg-[#e9ecef] text-[#5c5c5c] hover:bg-[#f1f0ff]",
                    "dark:bg-[#232329] dark:text-[#b8b8b8] dark:hover:bg-[#2d2d38]",
                  )}
                />
              </Link>
            )}
            <StorageWarning
              className={cn(
                "flex h-9 items-center justify-center rounded-[10px] p-2.5",
                "bg-[#e9ecef] hover:bg-[#f1f0ff]",
                "dark:bg-[#232329] dark:hover:bg-[#2d2d38]",
              )}
            />
          </div>
          {latestShareableLink && (
            <DrawingShareDialog
              drawingUrl={latestShareableLink}
              open={isShareDialogOpen}
              onOpenChange={setIsShareDialogOpen}
            />
          )}
        </Footer>

        <AppWelcomeScreen />
      </Excalidraw>
    </div>
  );
}
