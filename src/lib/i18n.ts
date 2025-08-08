import { useI18n as useExcalidrawI18n } from "@excalidraw/excalidraw";

type PlaceholderValues = Record<string, string | number>;

type AppTranslations = Record<string, Record<string, string>>;

// App-level i18n dictionary for keys not provided by Excalidraw
const appTranslations: AppTranslations = {
  en: {
    "app.export.disk.title": "Save to Disk",
    "app.export.cloud.title": "Cloud Upload",
    "app.export.cloud.subtitle": "Save the scene to cloud storage.",
    "app.export.cloud.loading": "Uploading...",
    "app.export.link.title": "Shareable link",
    "app.export.link.loading": "Exporting...",
  },
  "zh-TW": {
    "app.export.disk.title": "儲存到磁碟",
    "app.export.cloud.title": "雲端上傳",
    "app.export.cloud.subtitle": "將場景上傳至雲端儲存。",
    "app.export.cloud.loading": "上傳中...",
    "app.export.link.title": "可分享連結",
    "app.export.link.loading": "匯出中...",
  },
};

function formatPlaceholders(
  template: string,
  values?: PlaceholderValues,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function useAppI18n() {
  const { t: baseT, langCode } = useExcalidrawI18n();

  function t(key: string, values?: PlaceholderValues): string {
    const local = appTranslations[langCode]?.[key] ?? appTranslations.en?.[key];
    const raw = local ?? baseT(key);
    return formatPlaceholders(raw, values);
  }

  return { t, langCode } as const;
}
