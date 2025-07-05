import { MainMenu } from "@excalidraw/excalidraw";
import React from "react";
import { LanguageList } from "./app-language/language-list";
import type { Theme } from "@excalidraw/excalidraw/element/types";

interface AppMainMenuProps {
  theme: Theme | "system";
  setTheme: (theme: Theme | "system") => void;
  handleLangCodeChange: (langCode: string) => void;
}

function AppMainMenu(props: AppMainMenuProps) {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Socials />

      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme
        allowSystemTheme
        theme={props.theme}
        onSelect={props.setTheme}
      />
      <MainMenu.ItemCustom>
        <LanguageList handleLangCodeChange={props.handleLangCodeChange} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
}

export default React.memo(AppMainMenu);
