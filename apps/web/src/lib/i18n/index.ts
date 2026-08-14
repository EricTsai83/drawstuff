import type {
  AppDictionary,
  AppLanguage,
  AppTranslate,
  PlaceholderValues,
} from "./types";

export { APP_LANGUAGES } from "./types";
export type {
  AppDictionary,
  AppLanguage,
  AppTranslate,
  AppTranslationKey,
  PlaceholderValues,
} from "./types";

/**
 * 語言偏好 cookie：server render 前就能決定語言，
 * 讓 server HTML 與 client 首次 render 使用同一份字典。
 */
export const APP_LANGUAGE_COOKIE = "lang";

/** tag 等於 prefix，或以 `prefix-` 開頭（BCP-47 subtag 邊界，保留 extension）。 */
function matchesLanguageTag(tag: string, prefix: string): boolean {
  return tag === prefix || tag.startsWith(`${prefix}-`);
}

/** BCP-47 tag → app 支援語言；無法對應時回退 en。 */
export function normalizeAppLanguage(
  value: string | null | undefined,
): AppLanguage {
  if (!value) return "en";
  const tag = value.toLowerCase();
  const isTraditionalChinese =
    matchesLanguageTag(tag, "zh-tw") ||
    matchesLanguageTag(tag, "zh-hk") ||
    matchesLanguageTag(tag, "zh-mo") ||
    tag.startsWith("zh-hant");
  return isTraditionalChinese ? "zh-TW" : "en";
}

export function formatPlaceholders(
  template: string,
  values?: PlaceholderValues,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** 以固定字典建立 translate function；字典是完整的，因此不需要 key fallback。 */
export function createAppTranslate(dictionary: AppDictionary): AppTranslate {
  return (key, values) => formatPlaceholders(dictionary[key], values);
}
