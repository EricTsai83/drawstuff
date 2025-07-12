"use client";

import { MainMenu } from "@excalidraw/excalidraw";
import { useRef, memo } from "react";
import { LanguageList } from "./app-language/language-list";
import type { Theme } from "@excalidraw/excalidraw/element/types";
import Link from "next/link";
import { Bluesky, Github, Blog } from "@/components/icons";
import { useOutsideClick } from "@/hooks/use-outside-click";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { RenameSceneDialog } from "@/components/rename-scene-dialog";

type AppMainMenuProps = {
  theme: Theme | "system";
  setTheme: (theme: Theme | "system") => void;
  handleLangCodeChange: (langCode: string) => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
};

function AppMainMenu(props: AppMainMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useOutsideClick(menuRef, () => {
    const currentAppState = props.excalidrawAPI?.getAppState();
    if (currentAppState) {
      props.excalidrawAPI?.updateScene({
        appState: {
          ...currentAppState,
          openMenu: null,
        },
      });
    }
  });

  return (
    <MainMenu>
      <div ref={menuRef}>
        <RenameSceneDialog
          editorTheme={props.theme}
          excalidrawAPI={props.excalidrawAPI}
        />
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />

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
        <MainMenu.Separator />
        <div className="flex flex-row gap-2">
          <Link
            href="https://github.com/EricTsai83/excalidraw-ericts"
            target="_blank"
            rel="noopener"
            className="dropdown-menu-item dropdown-menu-item-base"
          >
            <div className="flex w-full justify-center">
              <Github />
            </div>
          </Link>
          <Link
            href="https://bsky.app/profile/ericts.com"
            target="_blank"
            rel="noopener"
            className="dropdown-menu-item dropdown-menu-item-base"
          >
            <div className="flex w-full justify-center">
              <Bluesky />
            </div>
          </Link>
          <Link
            href="https://ericts.com"
            target="_blank"
            rel="noopener"
            className="dropdown-menu-item dropdown-menu-item-base"
          >
            <div className="flex w-full justify-center">
              <Blog />
            </div>
          </Link>
        </div>
      </div>
    </MainMenu>
  );
}

export default memo(AppMainMenu);
