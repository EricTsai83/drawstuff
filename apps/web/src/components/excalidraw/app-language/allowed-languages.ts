import { EXCALIDRAW_LANGUAGES } from "@drawstuff/excalidraw-adapter/client";

// Only show two options: English and Chinese (Traditional)
const allowedLanguageCodes = new Set(["en", "zh-TW"]);

export const allowedLanguages = EXCALIDRAW_LANGUAGES.filter((lang) =>
  allowedLanguageCodes.has(lang.code),
);
