import { useState, useCallback } from "react";
import { STORAGE_KEYS } from "@/config/app-constants";
import { getPreferredLanguage } from "@/components/excalidraw/app-language/language-detector";
import { dispatchLanguageChange } from "@/lib/events";

export function useLanguagePreference() {
  const [langCode, setLangCode] = useState<string>(() => {
    if (typeof window === "undefined") return "en";
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE);
      if (stored) return stored;
    } catch {
      // Blocked storage: fall back to the browser preference.
    }
    return getPreferredLanguage();
  });

  const handleLangCodeChange = useCallback(function handleLangCodeChange(
    lang: string,
  ): void {
    setLangCode(lang);
    try {
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, lang);
    } catch {
      // Not persisted (quota or blocked storage); the switch still applies.
    }
    dispatchLanguageChange({ langCode: lang });
  }, []);

  return { langCode, handleLangCodeChange };
}
