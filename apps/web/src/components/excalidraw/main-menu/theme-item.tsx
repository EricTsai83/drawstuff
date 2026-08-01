"use client";

import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import type { Dispatch, SetStateAction } from "react";
import type { UserChosenTheme } from "@/hooks/use-sync-theme";

type ThemeItemProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
};

/** Upstream's own theme toggle, driven by the app's persisted theme choice. */
export function ThemeItem({ userChosenTheme, setTheme }: ThemeItemProps) {
  return (
    <MainMenu.DefaultItems.ToggleTheme
      allowSystemTheme
      theme={userChosenTheme}
      onSelect={setTheme}
    />
  );
}
