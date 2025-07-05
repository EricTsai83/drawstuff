"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCallbackRefState } from "@/hooks/use-callback-ref-state";
import { useDebounce } from "@/hooks/use-debounce";
import { importFromLocalStorage } from "@/data/local-storage";
import { resolvablePromise } from "@/lib/utils";
import { STORAGE_KEYS } from "@/config/app-constants";
import { getPreferredLanguage } from "./app-language/language-detector";
import AppMainMenu from "./app-main-menu";
import { useHandleAppTheme } from "@/hooks/use-handle-app-theme";
import AppWelcomeScreen from "./app-welcome-screen";

export default function ExcalidrawWrapper() {
  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();
  const savedLang = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
  const [langCode, setLangCode] = useState(savedLang || getPreferredLanguage());
  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  // 使用 resolvablePromise 來處理初始數據
  const initialStatePromiseRef = useRef<{
    promise: ReturnType<
      typeof resolvablePromise<ExcalidrawInitialDataState | null>
    >;
  }>({ promise: null! });

  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

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
  }, 300);

  // 初始化場景數據
  async function initializeScene(): Promise<ExcalidrawInitialDataState | null> {
    try {
      // 統一使用 importFromLocalStorage 來載入數據
      const localDataState = importFromLocalStorage();

      // 如果有數據，返回格式化的結果
      if (
        localDataState.elements.length > 0 ||
        localDataState.appState ||
        Object.keys(localDataState.files).length > 0
      ) {
        return {
          elements: localDataState.elements,
          appState: localDataState.appState || {},
          files: localDataState.files || {},
        };
      }

      // 如果都沒有數據，返回 null（使用預設空白畫布）
      return null;
    } catch (error) {
      console.error("初始化場景失敗:", error);
      return null;
    }
  }

  // 初始化場景
  useEffect(() => {
    const loadInitialScene = async () => {
      const scene = await initializeScene();
      initialStatePromiseRef.current.promise.resolve(scene);
    };

    loadInitialScene();
  }, []);

  // 監聽 excalidrawAPI 的變化
  useEffect(() => {
    if (excalidrawAPI) {
      // 保存原始的 resetScene 方法
      const originalResetScene = excalidrawAPI.resetScene;

      // 重寫 resetScene 方法
      excalidrawAPI.resetScene = (
        ...args: Parameters<typeof originalResetScene>
      ) => {
        // 調用原始方法
        const result = originalResetScene.apply(excalidrawAPI, args);

        // 清除 files
        try {
          localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_FILES);
          console.log("Reset Scene: 已清除 files 數據");
        } catch (error) {
          console.error("清除 files 數據失敗:", error);
        }

        return result;
      };
    }
  }, [excalidrawAPI]);

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

  // 頁面卸載前保存數據
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (excalidrawAPI) {
        const elements = excalidrawAPI.getSceneElements();
        const appState = excalidrawAPI.getAppState();
        const files = excalidrawAPI.getFiles();

        try {
          // 分別保存到對應的 key
          localStorage.setItem(
            STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
            JSON.stringify(elements),
          );
          localStorage.setItem(
            STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
            JSON.stringify(appState),
          );
          localStorage.setItem(
            STORAGE_KEYS.LOCAL_STORAGE_FILES,
            JSON.stringify(files),
          );
        } catch (error) {
          console.error("beforeunload 儲存數據失敗:", error);
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [excalidrawAPI]);

  function handleLangCodeChange(langCode: string) {
    setLangCode(langCode);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, langCode);
  }

  return (
    <div style={{ height: "100vh", width: "100%" }}>
      <Excalidraw
        excalidrawAPI={excalidrawRefCallback}
        initialData={initialStatePromiseRef.current.promise}
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
        />
        <AppWelcomeScreen />
      </Excalidraw>
    </div>
  );
}
