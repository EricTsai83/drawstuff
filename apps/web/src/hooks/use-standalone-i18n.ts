import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  appTranslations,
  formatPlaceholders,
  type PlaceholderValues,
} from "@/lib/i18n-shared";
import { LANGUAGE_CHANGE_EVENT, type LanguageChangeDetail } from "@/lib/events";

type StandaloneI18n = {
  readonly t: (key: string, values?: PlaceholderValues) => string;
  readonly langCode: string;
  readonly setLangCode: Dispatch<SetStateAction<string>>;
};

function readLanguageFromStorage(): string {
  if (typeof window === "undefined") return "en";
  return localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE) ?? "en";
}

export function useStandaloneI18n(): StandaloneI18n {
  const [langCode, setLangCode] = useState<string>(readLanguageFromStorage);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    function handleLanguageChange(event: Event): void {
      const customEvent = event as CustomEvent<LanguageChangeDetail>;
      const nextLangCode = customEvent.detail?.langCode;
      if (!nextLangCode) return;
      setLangCode(nextLangCode);
    }

    function handleStorage(event: StorageEvent): void {
      if (event.key !== STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE) return;
      setLangCode(readLanguageFromStorage());
    }

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  function t(key: string, values?: PlaceholderValues): string {
    const local = appTranslations[langCode]?.[key] ?? appTranslations.en?.[key];
    const raw = local ?? key;
    return formatPlaceholders(raw, values);
  }

  return { t, langCode, setLangCode } as const;
}
