import { useExcalidrawI18n } from "@/features/whiteboard/adapters/excalidraw";
import {
  appTranslations,
  formatPlaceholders,
  type PlaceholderValues,
} from "@/lib/i18n-shared";

export function useAppI18n() {
  const { t: baseT, langCode } = useExcalidrawI18n();

  function t(key: string, values?: PlaceholderValues): string {
    const local = appTranslations[langCode]?.[key] ?? appTranslations.en?.[key];
    const raw = local ?? baseT(key);
    return formatPlaceholders(raw, values);
  }

  return { t, langCode } as const;
}
