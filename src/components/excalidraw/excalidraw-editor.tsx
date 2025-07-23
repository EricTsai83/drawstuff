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

  const uiOptions = {
    canvasActions: {
      toggleTheme: true,
    },
  };

  const renderTopRightUI = (isMobile: boolean) => {
    return isMobile ? null : <DrawingShareDialog />;
  };

  // 2. 使用組件
  return (
    <div className="h-screen w-screen">
      <Excalidraw
        excalidrawAPI={excalidrawRefCallback}
        initialData={initialDataPromise}
        onChange={onChange}
        UIOptions={uiOptions}
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
          <div className="flex items-center gap-2.5">
            <Link href="/dashboard">
              <PanelsTopLeft
                className={cn(
                  "ml-2.5 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full p-2",
                  "bg-[#e9ecef] text-[#5c5c5c] hover:bg-[#f1f0ff]",
                  "dark:bg-[#232329] dark:text-[#b8b8b8] dark:hover:bg-[#2d2d38]",
                )}
              />
            </Link>
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
