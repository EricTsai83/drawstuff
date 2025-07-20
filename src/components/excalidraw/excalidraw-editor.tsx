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
import { StorageWarning } from "@/components/storage-warning";
import CustomStats from "./custom-stats";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { THEME } from "@excalidraw/excalidraw";

export default function ExcalidrawEditor() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const [sceneName, setSceneName] = useState("");
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang ?? getPreferredLanguage());
  const { theme: editorTheme, appTheme, setAppTheme } = useSyncTheme();
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

  return (
    <div className="h-screen w-screen">
      <Excalidraw
        excalidrawAPI={excalidrawRefCallback}
        initialData={initialDataPromise}
        onChange={onChange}
        UIOptions={uiOptions}
        langCode={langCode}
        theme={editorTheme}
        renderTopRightUI={renderTopRightUI}
        renderCustomStats={renderCustomStats}
      >
        <AppMainMenu
          theme={appTheme}
          setTheme={(theme) => setAppTheme(theme)}
          handleLangCodeChange={handleLangCodeChange}
          excalidrawAPI={excalidrawAPI}
        />
        <div
          className={cn(
            "fixed top-5 left-20 z-10 hidden w-40 text-lg font-medium",
            "overflow-hidden leading-none text-ellipsis lg:line-clamp-2",
            {
              "text-white": editorTheme === THEME.DARK,
              "text-black": editorTheme === THEME.LIGHT,
            },
          )}
        >
          {sceneName}
        </div>

        <Footer>
          <div className="flex items-center gap-2.5">
            <Link href="/dashboard">
              <LayoutDashboard
                className={cn(
                  "ml-2.5 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full p-2.5",
                  editorTheme === THEME.DARK
                    ? "bg-[#232329] text-neutral-200 hover:bg-[#2d2d38]"
                    : "bg-[#e9ecef] text-[#39393e] hover:bg-[#f1f0ff]",
                )}
              />
            </Link>
            <StorageWarning
              className={cn(
                "flex h-9 items-center justify-center rounded-[10px] p-2.5",
                editorTheme === THEME.DARK
                  ? "bg-[#232329] text-neutral-200 hover:bg-[#2d2d38]"
                  : "bg-[#e9ecef] text-[#39393e] hover:bg-[#f1f0ff]",
              )}
            />
          </div>
        </Footer>

        <AppWelcomeScreen theme={editorTheme} />
      </Excalidraw>
    </div>
  );
}
