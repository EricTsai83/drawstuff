// 型別入口：只用 `import type` 取 en 字典，型別會被完全抹除，
// 不會讓任何字典內容進入 runtime bundle。
import type { en } from "./en";

/** 應用層支援的語言；其餘 excalidraw 語言一律回退到 en 字典。 */
export type AppLanguage = "en" | "zh-TW";

/** 所有合法的 app 翻譯 key，由英文字典推導。 */
export type AppTranslationKey = keyof typeof en;

/** 完整字典：缺任何一個 key 都無法通過型別檢查。 */
export type AppDictionary = Record<AppTranslationKey, string>;

export type PlaceholderValues = Record<string, string | number>;

export type AppTranslate = (
  key: AppTranslationKey,
  values?: PlaceholderValues,
) => string;
