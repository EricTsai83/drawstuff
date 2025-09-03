import { languages, defaultLang } from "@excalidraw/excalidraw";

// Only show two options: English and Chinese (Traditional)
const allowedLanguageCodes = new Set(["en", "zh-TW"]);

export const allowedLanguages = languages.filter((lang) =>
  allowedLanguageCodes.has(lang.code),
);

export const allowedDefaultLangCode =
  allowedLanguages.find((lang) => lang.code === defaultLang.code)?.code ??
  (allowedLanguageCodes.has(defaultLang.code) ? defaultLang.code : undefined) ??
  "en";

export function isAllowedLanguageCode(code: string): boolean {
  return allowedLanguageCodes.has(code);
}

export function mapToAllowedLanguage(code: string | null | undefined): string {
  if (!code) return allowedDefaultLangCode;
  if (isAllowedLanguageCode(code)) return code;
  // Normalize any Chinese variant to zh-TW
  if (code.startsWith("zh")) return "zh-TW";
  return allowedDefaultLangCode;
}
