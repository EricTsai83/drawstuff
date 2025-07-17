"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, Footer } from "@excalidraw/excalidraw";
import { useState } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  UIAppState,
} from "@excalidraw/excalidraw/types";
import type {
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { useCallbackRefState } from "@/hooks/use-callback-ref-state";
import { useDebounce } from "@/hooks/use-debounce";
import { STORAGE_KEYS } from "@/config/app-constants";
import { getPreferredLanguage } from "./app-language/language-detector";
import AppMainMenu from "./app-main-menu";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import AppWelcomeScreen from "./app-welcome-screen";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { createInitialDataPromise, saveData } from "@/lib/excalidraw";
import { ShareLinkDialog } from "@/components/share-link-dialog";
import CustomStats from "./custom-stats";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { THEME } from "@excalidraw/excalidraw";

export default function ExcalidrawWrapper() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const [sceneName, setSceneName] = useState("");
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang ?? getPreferredLanguage());
  const { theme: editorTheme, appTheme, setAppTheme } = useSyncTheme();
  useBeforeUnload(excalidrawAPI);
  const [debouncedSave] = useDebounce(saveData, 300);

  const onChange = (
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
  };

  function handleLangCodeChange(langCode: string) {
    setLangCode(langCode);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, langCode);
  }

  function renderCustomStats(
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  }

  return (
    <div className="h-screen w-screen">
      <Excalidraw
        excalidrawAPI={excalidrawRefCallback}
        initialData={createInitialDataPromise}
        onChange={onChange}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
          },
        }}
        langCode={langCode}
        theme={editorTheme}
        renderTopRightUI={(isMobile) => {
          return isMobile ? null : <ShareLinkDialog />;
        }}
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
          <Link href="/dashboard">
            <LayoutDashboard
              className={cn(
                "ml-2.5 flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg p-2.5",
                editorTheme === THEME.DARK
                  ? "bg-[#232329] text-neutral-200 hover:bg-[#2e2e2e]"
                  : "bg-[#e9ecef] text-[#39393e] hover:bg-[#f1f0ff]",
              )}
            />
          </Link>
        </Footer>

        <AppWelcomeScreen theme={editorTheme} />
      </Excalidraw>
    </div>
  );
}
