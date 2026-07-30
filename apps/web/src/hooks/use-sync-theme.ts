"use client";

import { useTheme } from "next-themes";
import { EXCALIDRAW_THEME } from "@drawstuff/excalidraw-adapter/client";
import { type Dispatch, type SetStateAction } from "react";

export type UserChosenTheme = "system" | "dark" | "light";
type BrowserActiveTheme = "dark" | "light";

export function useSyncTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const userChosenTheme: UserChosenTheme =
    theme !== "system" && theme != "dark" && theme != "light"
      ? "system"
      : (theme ?? "system");

  const browserActiveTheme: BrowserActiveTheme =
    resolvedTheme === "dark" ? EXCALIDRAW_THEME.DARK : EXCALIDRAW_THEME.LIGHT;

  return {
    userChosenTheme,
    setTheme: setTheme as Dispatch<SetStateAction<UserChosenTheme>>,
    browserActiveTheme,
  };
}
