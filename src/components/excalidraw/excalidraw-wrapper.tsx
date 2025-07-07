"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import { useEffect, useState } from "react";
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
import { useHandleAppTheme } from "@/hooks/use-handle-app-theme";
import AppWelcomeScreen from "./app-welcome-screen";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { createInitialDataPromise } from "@/lib/excalidraw";

export default function ExcalidrawWrapper() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang || getPreferredLanguage());
  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();
  useBeforeUnload(excalidrawAPI);

  const [debouncedSave] = useDebounce((dataToSave) => {
    try {
      // 直接保存所有數據，不進行 files 清理
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
        JSON.stringify(dataToSave.elements),
      );
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
        JSON.stringify(dataToSave.appState),
      );
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_FILES,
        JSON.stringify(dataToSave.files),
      );
      console.log("數據已保存到本地存儲");
    } catch (error) {
      console.error("保存數據失敗:", error);
    }
  }, 30000);

  const onChange = (
    excalidrawElements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const dataToSave = {
      elements: excalidrawElements,
      appState: appState,
      files: files,
      timestamp: Date.now(),
    };

    debouncedSave(dataToSave);
  };

  function handleLangCodeChange(langCode: string) {
    setLangCode(langCode);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, langCode);
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
      >
        <AppMainMenu
          theme={appTheme}
          setTheme={(theme) => setAppTheme(theme)}
          handleLangCodeChange={handleLangCodeChange}
          excalidrawAPI={excalidrawAPI}
        />
        <AppWelcomeScreen />
      </Excalidraw>
    </div>
  );
}
