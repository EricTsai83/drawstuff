"use client";

import { MainMenu } from "@excalidraw/excalidraw";
import { useRef, memo, type Dispatch, type SetStateAction } from "react";
import { LanguageList } from "./app-language/language-list";
import Link from "next/link";
import { Bluesky, Github, Blog } from "@/components/icons";
import { useOutsideClick } from "@/hooks/use-outside-click";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { DrawingRenameDialog } from "@/components/drawing-rename-dialog";
import { LogIn } from "lucide-react";
import type { UserChosenTheme } from "@/hooks/use-sync-theme";

type AppMainMenuProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
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
        <DrawingRenameDialog excalidrawAPI={props.excalidrawAPI} />
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <Link href="/login" className="!no-underline">
          <MainMenu.Item
            className="!mt-0"
            data-testid="rename-scene-menu-item"
            icon={<LogIn strokeWidth={1.5} />}
            aria-label="Sign in"
          >
            Sign in
          </MainMenu.Item>
        </Link>

        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme
          allowSystemTheme
          theme={props.userChosenTheme}
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
