"use client";

import { MainMenu } from "@excalidraw/excalidraw";
import { useRef, memo, type Dispatch, type SetStateAction } from "react";
import { LanguageList } from "./app-language/language-list";
import Link from "next/link";
import { Bluesky, Github, Blog } from "@/components/icons";
import { useOutsideClick } from "@/hooks/use-outside-click";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { DrawingRenameDialog } from "@/components/drawing-rename-dialog";
import { LogIn, FilePenLine, LogOut } from "lucide-react";
import type { UserChosenTheme } from "@/hooks/use-sync-theme";
import { useI18n } from "@excalidraw/excalidraw";
import { authClient } from "@/lib/auth/client";
import { useRouter } from "next/navigation";

type AppMainMenuProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
  handleLangCodeChange: (langCode: string) => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
};

function AppMainMenu({
  userChosenTheme,
  setTheme,
  handleLangCodeChange,
  excalidrawAPI,
}: AppMainMenuProps) {
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const { data: session } = authClient.useSession();

  useOutsideClick(menuRef, () => {
    const currentAppState = excalidrawAPI?.getAppState();
    if (currentAppState) {
      excalidrawAPI?.updateScene({
        appState: {
          ...currentAppState,
          openMenu: null,
        },
      });
    }
  });

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/"); // redirect to login page
        },
      },
    });
  };

  return (
    <MainMenu>
      <div ref={menuRef}>
        <DrawingRenameDialog
          excalidrawAPI={excalidrawAPI}
          trigger={
            <div className="ml-2 flex cursor-pointer items-center gap-2.5 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">
              <FilePenLine strokeWidth={1.5} className="h-3.5 w-3.5" />
              {t("labels.fileTitle")}
            </div>
          }
        />
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />

        {session ? (
          <MainMenu.Item
            className="!mt-0"
            data-testid="rename-scene-menu-item"
            icon={<LogOut strokeWidth={1.5} />}
            aria-label="Sign out"
            onClick={handleSignOut}
          >
            Sign out
          </MainMenu.Item>
        ) : (
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
        )}

        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme
          allowSystemTheme
          theme={userChosenTheme}
          onSelect={setTheme}
        />
        <MainMenu.ItemCustom>
          <LanguageList handleLangCodeChange={handleLangCodeChange} />
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
