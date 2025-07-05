import { useI18n, languages } from "@excalidraw/excalidraw";
import React from "react";

export const LanguageList = ({
  handleLangCodeChange,
}: {
  handleLangCodeChange: (langCode: string) => void;
}) => {
  const { t, langCode } = useI18n();

  return (
    <select
      className="dropdown-select dropdown-select__language w-full text-sm"
      onChange={({ target }) => handleLangCodeChange(target.value)}
      value={langCode}
      aria-label={t("buttons.selectLanguage")}
    >
      {languages.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.label}
        </option>
      ))}
    </select>
  );
};
