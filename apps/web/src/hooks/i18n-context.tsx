"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { STORAGE_KEYS } from "@/config/app-constants";
import { LANGUAGE_CHANGE_EVENT, type LanguageChangeDetail } from "@/lib/events";
import {
  APP_LANGUAGE_COOKIE,
  createAppTranslate,
  normalizeAppLanguage,
  type AppDictionary,
  type AppLanguage,
  type AppTranslate,
} from "@/lib/i18n";
import { loadAppDictionary } from "@/lib/i18n/dictionary";

const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

type I18nContextValue = {
  readonly language: AppLanguage;
  readonly t: AppTranslate;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function writeLanguageCookie(language: AppLanguage): void {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${APP_LANGUAGE_COOKIE}=${language}; path=/; max-age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure}`;
}

type I18nProviderProps = {
  /** server 依 cookie／Accept-Language 解析的語言，client 首次 render 必須沿用同一個值。 */
  readonly initialLanguage: AppLanguage;
  readonly initialDictionary: AppDictionary;
  readonly children: React.ReactNode;
};

/**
 * 應用層 i18n 的唯一 runtime 來源：語言與字典都由 server 下發，
 * 因此 server HTML 與 hydration render 使用同一份字串，不再有 text mismatch。
 * 語言切換（excalidraw 選單、其他分頁）才 dynamic import 另一份字典。
 */
export function I18nProvider({
  initialLanguage,
  initialDictionary,
  children,
}: I18nProviderProps) {
  const [state, setState] = useState<{
    language: AppLanguage;
    dictionary: AppDictionary;
  }>({ language: initialLanguage, dictionary: initialDictionary });

  const stateRef = useRef(state);
  stateRef.current = state;
  const switchRequestRef = useRef(0);

  const applyLanguage = useCallback(
    async (rawLangCode: string | null | undefined): Promise<void> => {
      const language = normalizeAppLanguage(rawLangCode);
      writeLanguageCookie(language);
      // 一律遞增 generation：切出去又切回來時，先前那次未完成的載入必須失效，
      // 否則它會在使用者已切回原語言後才把舊目標寫進 state。
      const requestId = ++switchRequestRef.current;
      if (language === stateRef.current.language) return;

      const dictionary = await loadAppDictionary(language).catch(() => null);
      // 字典 chunk 載入失敗就維持當前語言；cookie 已更新，下次載入由 server 修正
      if (!dictionary || requestId !== switchRequestRef.current) return;
      setState({ language, dictionary });
    },
    [],
  );

  useEffect(() => {
    // client 端的語言偏好以 localStorage（excalidraw 自己的來源）為準，讓 app 字串
    // 與編輯器 UI 永遠同語言；沒有偏好時沿用瀏覽器語言。這一步同時把 cookie 補上，
    // 之後的載入就能在 server 直接渲染正確語言。
    void applyLanguage(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE) ??
        navigator.language,
    );

    function handleLanguageChange(event: Event): void {
      const detail = (event as CustomEvent<LanguageChangeDetail>).detail;
      if (!detail?.langCode) return;
      void applyLanguage(detail.langCode);
    }

    function handleStorage(event: StorageEvent): void {
      if (event.key !== STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE) return;
      void applyLanguage(event.newValue);
    }

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, [applyLanguage]);

  useEffect(() => {
    document.documentElement.lang = state.language;
  }, [state.language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language: state.language,
      t: createAppTranslate(state.dictionary),
    }),
    [state],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18nContext(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18nContext 必須在 <I18nProvider> 之下使用");
  }
  return value;
}
