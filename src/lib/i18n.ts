import { useI18n as useExcalidrawI18n } from "@excalidraw/excalidraw";

type PlaceholderValues = Record<string, string | number>;

type AppTranslations = Record<string, Record<string, string>>;

// App-level i18n dictionary for keys not provided by Excalidraw
const appTranslations: AppTranslations = {
  en: {
    "app.export.cloud.title": "Cloud Upload",
    "app.export.cloud.subtitle": "Save the scene to cloud storage.",
    "app.export.cloud.loading": "Uploading...",
    "app.export.link.loading": "Exporting...",
    "app.overwriteConfirm.action.uploadToCloud.button": "Upload to Cloud",
    "app.overwriteConfirm.modal.shareableLink.description":
      "You can choose to export the scene to an image, save it to disk, or upload it to the cloud. You can also choose to overwrite the existing scene.",
  },
  "zh-TW": {
    "app.export.cloud.title": "上傳雲端",
    "app.export.cloud.subtitle": "將場景上傳至雲端儲存。",
    "app.export.cloud.loading": "上傳中...",
    "app.export.link.loading": "匯出中...",
    "app.overwriteConfirm.action.uploadToCloud.button": "上傳雲端",
    "app.overwriteConfirm.modal.shareableLink.description":
      "您可以選擇將場景匯出為圖片、儲存到磁碟或上傳到雲端。您也可以選擇覆寫現有的場景。",
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
