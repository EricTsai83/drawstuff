import { languages } from "@excalidraw/excalidraw";

// Only show two options: English and Chinese (Traditional)
const allowedLanguageCodes = new Set(["en", "zh-TW"]);

export const allowedLanguages = languages.filter((lang) =>
  allowedLanguageCodes.has(lang.code),
);
