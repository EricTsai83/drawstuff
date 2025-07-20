"use client";

import { useTheme } from "next-themes";
import { THEME } from "@excalidraw/excalidraw";
import type { Theme } from "@excalidraw/excalidraw/element/types";
import { useMemo, useCallback } from "react";

export function useSyncTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  // 使用 useMemo 來緩存主題值，避免無限重新渲染
  const excalidrawTheme = useMemo((): Theme => {
    if (theme === "system") {
      return resolvedTheme === "dark" ? THEME.DARK : THEME.LIGHT;
    }
    return theme === "dark" ? THEME.DARK : THEME.LIGHT;
  }, [theme, resolvedTheme]);

  // 使用 useCallback 緩存 setExcalidrawTheme 函數
  const setExcalidrawTheme = useCallback(
    (excalidrawTheme: Theme | "system") => {
      if (excalidrawTheme === "system") {
        setTheme("system");
      } else {
        setTheme(excalidrawTheme === THEME.DARK ? "dark" : "light");
      }
    },
    [setTheme],
  );

  // 使用 useCallback 緩存 setAppTheme 函數
  const setAppThemeCallback = useCallback(
    (theme: string) => {
      setTheme(theme);
    },
    [setTheme],
  );

  return {
    theme: excalidrawTheme,
    setTheme: setExcalidrawTheme,
    appTheme: theme as Theme | "system",
    setAppTheme: setAppThemeCallback,
    isDark: resolvedTheme === "dark",
  };
}
