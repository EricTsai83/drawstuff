import { useCallback } from "react";
import { useExcalidrawI18n } from "@drawstuff/excalidraw-adapter/client";
import {
  appTranslations,
  formatPlaceholders,
  type PlaceholderValues,
} from "@/lib/i18n-shared";

export function useAppI18n() {
  const { t: baseT, langCode } = useExcalidrawI18n();

  const t = useCallback(
    (key: string, values?: PlaceholderValues): string => {
      const local =
        appTranslations[langCode]?.[key] ?? appTranslations.en?.[key];
      const raw = local ?? baseT(key);
      return formatPlaceholders(raw, values);
    },
    [baseT, langCode],
  );

  return { t, langCode } as const;
}
