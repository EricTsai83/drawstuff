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
import { Download, FileDown, PanelsTopLeft } from "lucide-react";
import { DrawingNameTrigger } from "@/components/drawing-name-trigger";
import { authClient } from "@/lib/auth/client";
import {
  CloudUploadStatus,
  type UploadStatus,
} from "@/components/excalidraw/cloud-upload-status";
import { useSceneExport } from "@/hooks/use-scene-export";
import { Button } from "@/components/ui/button";
import { Loader2, Share, Link } from "lucide-react";
import { toast } from "sonner";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

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

  // 自定義 export UI
  const renderCustomExportUI = useCallback(
    (
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
      canvas: unknown,
    ) => {
      const isExporting = exportStatus === "exporting";

      // 處理儲存到磁碟的功能
      const handleSaveToDisk = () => {
        try {
          // 創建 Excalidraw 檔案內容
          const sceneData = {
            type: "excalidraw",
            version: 2,
            source: "https://excalidraw.com",
            elements: elements,
            appState: appState,
            files: files,
          };

          // 創建 Blob
          const blob = new Blob([JSON.stringify(sceneData)], {
            type: "application/json",
          });

          // 創建下載連結
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${appState.name ?? "drawing"}.excalidraw`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);

          toast.success("File saved to disk successfully!");
        } catch (error) {
          console.error("Save failed:", error);
          toast.error("Failed to save file. Please try again.");
        }
      };

      return (
        <div className="flex flex-col items-center justify-center gap-6 p-8 text-center">
          {/* 大圖標 */}
          <div className="bg-primary/10 border-primary/20 flex h-20 w-20 items-center justify-center rounded-full border">
            <FileDown className="text-primary h-10 w-10" />
          </div>

          {/* 標題文字 */}
          <div className="space-y-2">
            <h3 className="text-foreground text-lg font-semibold">
              Export Options
            </h3>
            <p className="text-muted-foreground text-sm">
              Choose export method
            </p>
          </div>

          {/* 按鈕容器 - 響應式佈局 */}
          <div className="flex w-full max-w-md flex-col gap-4 sm:flex-row">
            {/* Save to Disk 按鈕 */}
            <Button
              className="flex h-12 flex-1 items-center justify-center gap-3"
              variant="default"
              size="lg"
              onClick={handleSaveToDisk}
            >
              <Download className="h-4 w-4" />
              Save to Disk
            </Button>

            {/* Export to Link 按鈕 */}
            <Button
              className="flex h-12 flex-1 items-center justify-center gap-3 bg-pink-500/90 text-white hover:bg-pink-600 disabled:opacity-50"
              variant="default"
              size="lg"
              disabled={isExporting}
              onClick={() => {
                if (isExporting) return;

                void (async () => {
                  try {
                    const shareableUrl = await exportScene(
                      elements,
                      appState,
                      files,
                    );
                    if (shareableUrl) {
                      // 關閉 export 對話框，然後顯示 ShareableLinkDialog
                      if (excalidrawAPI) {
                        const currentAppState = excalidrawAPI.getAppState();
                        if (currentAppState) {
                          excalidrawAPI.updateScene({
                            appState: {
                              ...currentAppState,
                              openDialog: null,
                            },
                          });
                        }
                      }
                      setTimeout(() => {
                        setIsShareDialogOpen(true);
                      }, 200);
                    } else {
                      toast.error("Failed to export scene. Please try again.");
                    }
                  } catch (error) {
                    console.error("Export error:", error);
                    toast.error("Failed to export scene. Please try again.");
                  }
                })();
              }}
            >
              {isExporting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Link className="h-4 w-4" />
                  Export to Link
                </>
              )}
            </Button>
          </div>
        </div>
      );
    },
    [exportStatus, exportScene, setIsShareDialogOpen, excalidrawAPI],
  );

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
