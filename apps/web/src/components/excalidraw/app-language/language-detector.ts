import {
  DEFAULT_EXCALIDRAW_LANGUAGE,
  EXCALIDRAW_LANGUAGES,
} from "@drawstuff/excalidraw-adapter/client";
import LanguageDetector from "i18next-browser-languagedetector";

const languageDetector = new LanguageDetector();

languageDetector.init({
  languageUtils: {},
});

export const getPreferredLanguage = () => {
  const detectedLanguages = languageDetector.detect();

  const detectedLanguage = Array.isArray(detectedLanguages)
    ? detectedLanguages[0]
    : detectedLanguages;

  const initialLanguage =
    (detectedLanguage
      ? // region code may not be defined if user uses generic preferred language
        // (e.g. chinese vs instead of chinese-simplified)
        EXCALIDRAW_LANGUAGES.find((lang) =>
          lang.code.startsWith(detectedLanguage),
        )?.code
      : null) ?? DEFAULT_EXCALIDRAW_LANGUAGE.code;

  return initialLanguage;
};
