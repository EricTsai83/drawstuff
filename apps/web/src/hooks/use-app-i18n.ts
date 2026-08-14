"use client";

import { useI18nContext } from "@/hooks/i18n-context";
import type { AppLanguage, AppTranslate } from "@/lib/i18n";

type AppI18n = {
  readonly t: AppTranslate;
  readonly langCode: AppLanguage;
};

/**
 * 應用層字串的唯一取用入口，編輯器內外共用同一份由 server 下發的字典。
 * `t` 只接受 AppTranslationKey，打錯 key 是編譯錯誤而非 runtime echo。
 */
export function useAppI18n(): AppI18n {
  const { t, language } = useI18nContext();
  return { t, langCode: language };
}
