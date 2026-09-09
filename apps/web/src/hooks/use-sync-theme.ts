"use client";

import { useTheme } from "next-themes";
import { EXCALIDRAW_THEME } from "@drawstuff/excalidraw-adapter/client";
import { useCallback, type SetStateAction } from "react";

export type UserChosenTheme = "system" | "dark" | "light";
type BrowserActiveTheme = "dark" | "light";

export function useSyncTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const userChosenTheme: UserChosenTheme =
    theme === "light" || theme === "dark" ? theme : "system";
  const setUserChosenTheme = useCallback(
    (next: SetStateAction<UserChosenTheme>) =>
      setTheme((current) =>
        typeof next === "function"
          ? next(current === "light" || current === "dark" ? current : "system")
          : next,
      ),
    [setTheme],
  );

  const browserActiveTheme: BrowserActiveTheme =
    resolvedTheme === "dark" ? EXCALIDRAW_THEME.DARK : EXCALIDRAW_THEME.LIGHT;

  return {
    userChosenTheme,
    setTheme: setUserChosenTheme,
    browserActiveTheme,
  };
}
