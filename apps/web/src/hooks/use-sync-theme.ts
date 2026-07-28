"use client";

import { useTheme } from "next-themes";
import { THEME } from "@excalidraw/excalidraw";
import { type Dispatch, type SetStateAction } from "react";

export type UserChosenTheme = "system" | "dark" | "light";
export type BrowserActiveTheme = "dark" | "light";

export function useSyncTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const userChosenTheme: UserChosenTheme =
    theme !== "system" && theme != "dark" && theme != "light"
      ? "system"
      : (theme ?? "system");

  const browserActiveTheme: BrowserActiveTheme =
    resolvedTheme === "dark" ? THEME.DARK : THEME.LIGHT;

  return {
    userChosenTheme,
    setTheme: setTheme as Dispatch<SetStateAction<UserChosenTheme>>,
    browserActiveTheme,
  };
}
