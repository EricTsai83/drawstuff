"use client";

import { useTheme } from "next-themes";
import { THEME } from "@excalidraw/excalidraw";
import type { Theme } from "@excalidraw/excalidraw/element/types";
import { useMemo } from "react";

export function useSyncTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  // 使用 useMemo 來緩存主題值，避免無限重新渲染
  const excalidrawTheme = useMemo((): Theme => {
    if (theme === "system") {
      return resolvedTheme === "dark" ? THEME.DARK : THEME.LIGHT;
    }
    return theme === "dark" ? THEME.DARK : THEME.LIGHT;
  }, [theme, resolvedTheme]);

  // 將 Excalidraw 的 theme 轉換為 next-themes 的 theme
  const setExcalidrawTheme = (excalidrawTheme: Theme | "system") => {
    if (excalidrawTheme === "system") {
      setTheme("system");
    } else {
      setTheme(excalidrawTheme === THEME.DARK ? "dark" : "light");
    }
  };

  return {
    theme: excalidrawTheme,
    setTheme: setExcalidrawTheme,
    appTheme: theme as Theme | "system",
    setAppTheme: setTheme as (theme: string) => void,
    isDark: resolvedTheme === "dark",
  };
}
