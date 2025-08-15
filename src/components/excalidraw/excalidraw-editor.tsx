"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, Footer } from "@excalidraw/excalidraw";
import { useState, useCallback, useEffect, useMemo } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  UIAppState,
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
import { SceneShareDialog } from "@/components/scene-share-dialog";
import { SceneRenameDialog } from "@/components/scene-rename-dialog";
import { StorageWarning } from "@/components/storage-warning";
import CustomStats from "./custom-stats";
import { cn } from "@/lib/utils";
import { PanelsTopLeft } from "lucide-react";
import Link from "next/link";
import { SceneNameTrigger } from "@/components/scene-name-trigger";
import { authClient } from "@/lib/auth/client";
import { useSceneExport } from "@/hooks/use-scene-export";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { toast } from "sonner";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  ExportSceneActions,
  type ExportSceneActionsProps,
} from "./export-scene-actions";
import type { ExcalidrawSceneData } from "@/lib/excalidraw";
import { createJsonBlob, triggerBlobDownload } from "@/lib/download";
import {
  closeExcalidrawDialog,
  getCurrentSceneSnapshot,
} from "@/lib/excalidraw";
import { TopRightControls } from "./top-right-controls";
import { OverwriteConfirmDialog } from "@/components/excalidraw/overwrite-confirm-dialog";
import { api } from "@/trpc/react";
import { decompressData } from "@/lib/encode";
import type { DataURL, BinaryFileData } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";

export default function ExcalidrawEditor() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const [sceneName, setSceneName] = useState("");
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang ?? getPreferredLanguage());
  const { userChosenTheme, setTheme, browserActiveTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
  const [debouncedSave] = useDebounce(saveData, 300);
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

  const exportAndMaybeOpenShareDialog = useCallback(
    async function exportAndMaybeOpenShareDialog(
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
      options?: { openShareDialog?: boolean },
    ): Promise<string | null> {
      try {
        const shareableUrl = await exportScene(elements, appState, files);
        if (!shareableUrl) return null;

        closeExcalidrawDialog(excalidrawAPI);

        if (options?.openShareDialog) {
          // 略延遲讓 Excalidraw 關閉動畫更順暢
          setTimeout(() => setIsShareDialogOpen(true), 200);
        }

        return shareableUrl;
      } catch (error: unknown) {
        console.error("Export error:", error);
        toast.error("Failed to export scene. Please try again.");
        return null;
      }
    },
    [exportScene, excalidrawAPI],
  );

  const handleSceneChange = useCallback(
    function handleSceneChange(
      excalidrawElements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ): void {
      setSceneName(appState.name ?? "");
      debouncedSave({ elements: excalidrawElements, appState, files });
    },
    [debouncedSave],
  );

  const handleLangCodeChange = useCallback(function handleLangCodeChange(
    lang: string,
  ): void {
    setLangCode(lang);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, lang);
  }, []);

  const renderCustomStats = useCallback(function renderCustomStats() {
    return <CustomStats />;
  }, []);

  useEffect(function initializeInitialDataPromise() {
    // 註冊 handler 後再建立 initialDataPromise，避免 race
    setInitialDataPromise(createInitialDataPromise());
  }, []);

  // 解析分享 hash
  const parsedShare = useMemo(() => {
    const m = /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/.exec(
      window.location.hash,
    );
    return m ? { id: m[1]!, key: m[2]! } : null;
  }, []);

  // 取得該分享場景相關檔案清單（UploadThing）
  const filesListQuery = api.sharedScene.getFileRecordsBySharedSceneId.useQuery(
    { sharedSceneId: parsedShare?.id ?? "" },
    { enabled: !!parsedShare?.id },
  );

  // 後載雲端檔案，並在載入後逐步加進 Excalidraw（改善首屏）
  useEffect(
    function loadCloudFilesAfterMount() {
      if (!excalidrawAPI || !parsedShare?.key) return;
      const files = filesListQuery.data?.files ?? [];
      if (!files.length) return;

      let cancelled = false;

      async function load() {
        const loaded: BinaryFiles = {};
        const decryptionKey = parsedShare!.key;
        // const errored = new Map<FileId, true>(); // 若要標示錯誤，可啟用

        for (const f of files) {
          try {
            const resp = await fetch(f.url);
            if (!resp.ok) continue;
            const buf = new Uint8Array(await resp.arrayBuffer());
            const { metadata, data } = await decompressData<{
              id: string;
              mimeType: string;
              created: number;
              lastRetrieved: number;
            }>(buf, { decryptionKey });

            const id = metadata.id as unknown as FileId;
            loaded[id] = {
              id,
              dataURL: new TextDecoder().decode(data) as DataURL,
              mimeType: metadata.mimeType as BinaryFileData["mimeType"],
              created: metadata.created,
              lastRetrieved: metadata.lastRetrieved,
            };
          } catch {
            // 若要：errored.set(fileId, true);
          }
        }

        if (cancelled) return;
        if (Object.keys(loaded).length && excalidrawAPI) {
          const loadedArray = Object.values(loaded);
          excalidrawAPI.addFiles(loadedArray);
        }
        // 若要：updateStaleImageStatuses(...)
      }

      void load();
      return () => {
        cancelled = true;
      };
    },
    [excalidrawAPI, filesListQuery.data, parsedShare],
  );

  const renderCustomExportUI = useCallback(
    function renderCustomExportUI(
      elements: readonly NonDeletedExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
      _canvas: unknown,
    ) {
      const handlers: ExportSceneActionsProps["handlers"] = {
        handleSaveToDisk: function handleSaveToDisk(
          els: readonly NonDeletedExcalidrawElement[],
          state: Partial<AppState>,
          fls: BinaryFiles,
        ) {
          try {
            const sceneData: ExcalidrawSceneData = {
              type: "excalidraw",
              version: 2,
              source: "https://excalidraw.com",
              elements: els,
              appState: state,
              files: fls,
            };
            const blob = createJsonBlob(sceneData);
            triggerBlobDownload(`${state.name ?? "scene"}.excalidraw`, blob);
            toast.success("File saved to disk successfully!");
          } catch (err: unknown) {
            console.error("Save failed:", err);
            toast.error("Failed to save file. Please try again.");
          }
        },
        handleCloudUpload: async function handleCloudUpload(
          els: readonly NonDeletedExcalidrawElement[],
          state: Partial<AppState>,
          fls: BinaryFiles,
        ) {
          try {
            const ok = await uploadSceneToCloud(els, state, fls);
            if (ok) {
              toast.success("Successfully uploaded to cloud!");
            } else {
              toast.error("Failed to upload to cloud. Please try again.");
            }
          } catch (err: unknown) {
            console.error("Cloud upload error:", err);
            toast.error("Failed to upload to cloud. Please try again.");
          }
        },
        handleExportLink: async function handleExportLink(
          els: readonly NonDeletedExcalidrawElement[],
          state: Partial<AppState>,
          fls: BinaryFiles,
        ) {
          if (exportStatus === "exporting" || uploadStatus === "uploading")
            return;
          const shareableUrl = await exportAndMaybeOpenShareDialog(
            els,
            state,
            fls,
            { openShareDialog: true },
          );
          if (!shareableUrl) {
            toast.error("Failed to export scene. Please try again.");
          }
        },
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
      exportAndMaybeOpenShareDialog,
      exportStatus,
      uploadStatus,
      uploadSceneToCloud,
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
      const result = await exportAndMaybeOpenShareDialog(
        scene.elements as readonly NonDeletedExcalidrawElement[],
        scene.appState,
        scene.files,
        { openShareDialog: true },
      );
      if (!result) {
        toast.error("Failed to export scene. Please try again.");
      }
    },
    [exportAndMaybeOpenShareDialog, excalidrawAPI],
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
          />

          <SceneRenameDialog
            excalidrawAPI={excalidrawAPI}
            trigger={<SceneNameTrigger sceneName={sceneName} />}
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
              <SceneShareDialog
                sceneUrl={latestShareableLink}
                open={isShareDialogOpen}
                onOpenChange={setIsShareDialogOpen}
              />
            )}
          </Footer>

          <AppWelcomeScreen />
          <OverwriteConfirmDialog excalidrawAPI={excalidrawAPI} />
        </Excalidraw>
      )}
    </div>
  );
}
