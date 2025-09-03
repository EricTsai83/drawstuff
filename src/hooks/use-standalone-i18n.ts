import { useState } from "react";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  appTranslations,
  formatPlaceholders,
  type PlaceholderValues,
} from "@/lib/i18n-shared";

export function useStandaloneI18n() {
  const [langCode, setLangCode] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE) ?? "en";
    }
    return "en";
  });

  function t(key: string, values?: PlaceholderValues): string {
    const local = appTranslations[langCode]?.[key] ?? appTranslations.en?.[key];
    const raw = local ?? key;
    return formatPlaceholders(raw, values);
  }

  return { t, langCode, setLangCode } as const;
}
