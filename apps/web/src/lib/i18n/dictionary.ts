import type { AppDictionary, AppLanguage } from "./types";

/**
 * 唯一的字典載入點，兩種語言都走 dynamic import：
 * client build 因此把每個字典切成獨立 async chunk，共用 chunk 不含任何字典。
 * server 端會在 render 前 await 解析結果並透過 provider 下發。
 */
export async function loadAppDictionary(
  language: AppLanguage,
): Promise<AppDictionary> {
  if (language === "zh-TW") {
    return (await import("./zh-tw")).zhTW;
  }
  return (await import("./en")).en;
}
