import { useI18n as useExcalidrawI18n } from "@excalidraw/excalidraw";
import { useState } from "react";
import { STORAGE_KEYS } from "@/config/app-constants";

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
    "app.cloudUpload.tooltip.idle": "Waiting to upload to cloud",
    "app.cloudUpload.tooltip.uploading": "Uploading to cloud",
    "app.cloudUpload.tooltip.success": "Synced to cloud",
    "app.cloudUpload.tooltip.error": "Upload failed, click to retry",
    "app.cloudUpload.tooltip.offline": "Currently offline",
    "app.cloudUpload.toast.success": "Scene successfully uploaded to cloud!",
    "app.cloudUpload.toast.error.sceneData":
      "Unable to get current scene data, please try again.",
    "app.cloudUpload.toast.error.saveScene":
      "Error occurred while saving scene, please try again.",
    "app.cloudUpload.toast.error.upload":
      "Error occurred while uploading scene to cloud, please try again.",
    "app.cloudUpload.toast.error.unknown":
      "Unknown error occurred while uploading scene to cloud, please try again.",
  },
  "zh-TW": {
    "app.export.cloud.title": "上傳雲端",
    "app.export.cloud.subtitle": "將場景上傳至雲端儲存。",
    "app.export.cloud.loading": "上傳中...",
    "app.export.link.loading": "匯出中...",
    "app.overwriteConfirm.action.uploadToCloud.button": "上傳雲端",
    "app.overwriteConfirm.modal.shareableLink.description":
      "您可以選擇將場景匯出為圖片、儲存到磁碟或上傳到雲端。您也可以選擇覆寫現有的場景。",
    "app.cloudUpload.tooltip.idle": "等待上傳到雲端",
    "app.cloudUpload.tooltip.uploading": "正在上傳到雲端",
    "app.cloudUpload.tooltip.success": "已同步到雲端",
    "app.cloudUpload.tooltip.error": "上傳失敗，點擊重試",
    "app.cloudUpload.tooltip.offline": "目前離線",
    "app.cloudUpload.toast.success": "場景已成功上傳至雲端！",
    "app.cloudUpload.toast.error.sceneData": "無法取得當前場景資料，請重試。",
    "app.cloudUpload.toast.error.saveScene": "儲存場景時發生錯誤，請重試。",
    "app.cloudUpload.toast.error.upload": "上傳場景至雲端時發生錯誤，請重試。",
    "app.cloudUpload.toast.error.unknown":
      "上傳場景至雲端時發生未知錯誤，請重試。",
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

// Standalone i18n hook for use outside Excalidraw context
export function useStandaloneI18n() {
  // Get language from localStorage or default to English
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
