"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, useDevice } from "@excalidraw/excalidraw";
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
import { useHandleAppTheme } from "@/hooks/use-handle-app-theme";
import AppWelcomeScreen from "./app-welcome-screen";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { createInitialDataPromise, saveData } from "@/lib/excalidraw";
import { ShareLinkDialog } from "@/components/share-link-dialog";
import CustomStats from "./custom-stats";

export default function ExcalidrawWrapper() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang ?? getPreferredLanguage());
  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();
  useBeforeUnload(excalidrawAPI);
  const [debouncedSave] = useDebounce(saveData, 300);
  const device = useDevice();

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
          // 同步 Excalidraw 內部的設備狀態
          // setIsMobileFromExcalidraw(isMobile);
          return isMobile ? null : (
            <ShareLinkDialog editorTheme={editorTheme} />
          );
        }}
        renderCustomStats={renderCustomStats}
      >
        <AppMainMenu
          theme={appTheme}
          setTheme={(theme) => setAppTheme(theme)}
          handleLangCodeChange={handleLangCodeChange}
          excalidrawAPI={excalidrawAPI}
        />

        {device.editor.isMobile ? null : (
          <div className="fixed top-5 left-20 z-10 text-lg font-medium text-white dark:text-gray-300">
            {excalidrawAPI?.getName()}
          </div>
        )}

        <AppWelcomeScreen theme={editorTheme} />
      </Excalidraw>
    </div>
  );
}
