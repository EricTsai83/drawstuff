import "server-only";
import { cookies, headers } from "next/headers";

import { APP_LANGUAGE_COOKIE, normalizeAppLanguage } from ".";
import { loadAppDictionary } from "./dictionary";
import type { AppDictionary, AppLanguage } from "./types";

/**
 * 沒有 cookie 的首次造訪用 Accept-Language 猜語言，
 * 讓 server HTML 儘量等於 client 依 navigator.language 得到的結果，避免 hydration 後才切語言。
 */
function languageFromAcceptLanguage(header: string | null): AppLanguage {
  if (!header) return "en";

  // 每個支援語言取最高有效 q（含 wildcard 授予的），q=0 為明確拒絕（RFC 9110）。
  const quality = new Map<AppLanguage | "*", number>();

  for (const entry of header.split(",")) {
    const [rawTag, ...params] = entry.split(";");
    const tag = rawTag?.trim().toLowerCase();
    if (!tag) continue;

    let key: AppLanguage | "*";
    if (tag === "*") {
      key = "*";
    } else if (tag === "en" || tag.startsWith("en-")) {
      key = "en";
    } else if (normalizeAppLanguage(tag) === "zh-TW") {
      key = "zh-TW";
    } else {
      // 其他語言（de、enb、zh-CN…）不是本 app 的候選者，也不可誤當英文
      continue;
    }

    const rawQuality = params
      .map((param) => param.trim())
      .find((param) => param.toLowerCase().startsWith("q="))
      ?.slice(2);
    const parsed = rawQuality === undefined ? 1 : Number(rawQuality);
    if (!Number.isFinite(parsed) || parsed < 0) continue;

    quality.set(key, Math.max(quality.get(key) ?? 0, parsed));
  }

  // 未明確列出的語言承接 wildcard 的 q；q=0（明確拒絕）在此淘汰
  const wildcard = quality.get("*");
  const effective = (language: AppLanguage): number =>
    quality.get(language) ?? wildcard ?? 0;

  const en = effective("en");
  const zhTW = effective("zh-TW");
  if (zhTW > en) return "zh-TW";
  return "en";
}

/**
 * 在 server 決定語言並解析字典，供 root layout 設定 `<html lang>` 與 I18nProvider 初值。
 * 字典只在 server 端組裝，因此 client bundle 不需要靜態引入任何語言表。
 */
export async function resolveRequestI18n(): Promise<{
  language: AppLanguage;
  dictionary: AppDictionary;
}> {
  const cookieStore = await cookies();
  const stored = cookieStore.get(APP_LANGUAGE_COOKIE)?.value;
  const language = stored
    ? normalizeAppLanguage(stored)
    : languageFromAcceptLanguage((await headers()).get("accept-language"));

  return { language, dictionary: await loadAppDictionary(language) };
}
