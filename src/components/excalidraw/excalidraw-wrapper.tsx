"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import { useState } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
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
import { createInitialDataPromise, saveData } from "@/lib/excalidraw";

export default function ExcalidrawWrapper() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang || getPreferredLanguage());
  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();
  useBeforeUnload(excalidrawAPI);

  const [debouncedSave] = useDebounce(saveData, 300);

  const onChange = (
    excalidrawElements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const data: ExcalidrawInitialDataState = {
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
