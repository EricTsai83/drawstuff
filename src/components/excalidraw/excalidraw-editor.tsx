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
import {
  exportSceneToBackend,
  prepareSceneDataForExport,
} from "@/lib/export-scene-to-backend";
import { useUploadThing } from "@/lib/uploadthing";

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

  // 文件上傳 hook
  const { startUpload } = useUploadThing("sceneFileUploader", {
    onClientUploadComplete: (res) => {
      console.log("Files uploaded successfully!", res);
      setUploadStatus("success");

      // TODO: 實作檔案 URL 儲存邏輯
      // 這裡可以根據實際的 UploadThing 回應格式來處理
      console.log("Upload response:", res);
    },
    onUploadError: (error) => {
      console.error("Error occurred while uploading files", error);
      setUploadStatus("error");
    },
    onUploadBegin: (fileName) => {
      console.log("Upload has begun for", fileName);
      setUploadStatus("uploading");
    },
  });

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

  const renderTopRightUI = (isMobile: boolean) => {
    return isMobile ? null : (
      <>
        <CloudUploadStatus
          status={uploadStatus}
          errorMessage="網路連線失敗"
          onClick={handleRetry}
          onSuccess={handleSuccess}
        />
        <DrawingShareDialog />
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
                  try {
                    // 先準備場景數據
                    const sceneData = await prepareSceneDataForExport(
                      elements,
                      appState,
                      files,
                    );

                    // 如果有文件需要上傳，先上傳文件
                    if (sceneData.compressedFilesData.length > 0) {
                      // 將 Uint8Array 直接轉換為 File 對象用於上傳
                      const filesToUpload = sceneData.compressedFilesData.map(
                        (file) => {
                          return new File(
                            [file.buffer],
                            `${file.id}.encrypted.bin`,
                            {
                              type: "application/octet-stream",
                            },
                          );
                        },
                      );

                      await startUpload(filesToUpload);
                    }

                    // 然後導出場景到後端
                    const result = await exportSceneToBackend(
                      elements,
                      appState,
                      files,
                    );

                    if (result.url) {
                      console.log("Scene exported successfully:", result.url);
                    } else {
                      console.error(
                        "Failed to export scene:",
                        result.errorMessage,
                      );
                    }
                  } catch (error) {
                    console.error("Error during scene export:", error);
                  }
                })();
              },
              renderCustomUI: (elements, appState, files, canvas) => {
                // console.log("elements", elements);
                // console.log("appState", appState);
                // console.log("files", files);
                // console.log("canvas", canvas);
                return <div>Hello</div>;
              },
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
        </Footer>

        <AppWelcomeScreen />
      </Excalidraw>
    </div>
  );
}
