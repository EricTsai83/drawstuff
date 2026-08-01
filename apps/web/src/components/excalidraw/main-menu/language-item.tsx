"use client";

import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import { LanguageSelector } from "../app-language/language-selector";

type LanguageItemProps = {
  langCode: string;
  onLangCodeChange: (langCode: string) => void;
};

export function LanguageItem({
  langCode,
  onLangCodeChange,
}: LanguageItemProps) {
  return (
    <MainMenu.ItemCustom>
      <LanguageSelector value={langCode} onValueChange={onLangCodeChange} />
    </MainMenu.ItemCustom>
  );
}
