import {
  allowedDefaultLangCode,
  mapToAllowedLanguage,
} from "./allowed-languages";
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

  return detectedLanguage
    ? mapToAllowedLanguage(detectedLanguage)
    : allowedDefaultLangCode;
};
