import { useState, useCallback } from "react";
import { STORAGE_KEYS } from "@/config/app-constants";
import { getPreferredLanguage } from "@/components/excalidraw/app-language/language-detector";

export function useLanguagePreference() {
  const [langCode, setLangCode] = useState<string>(() => {
    if (typeof window === "undefined") return "en";
    return (
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE) ??
      getPreferredLanguage()
    );
  });

  const handleLangCodeChange = useCallback(function handleLangCodeChange(
    lang: string,
  ): void {
    setLangCode(lang);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, lang);
  }, []);

  return { langCode, handleLangCodeChange };
}
