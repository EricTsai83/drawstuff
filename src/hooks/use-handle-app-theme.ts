import { THEME } from "@excalidraw/excalidraw";
import { useLayoutEffect, useState } from "react";

import type { Theme } from "@excalidraw/excalidraw/element/types";

import { STORAGE_KEYS } from "@/config/app-constants";

const getDarkThemeMediaQuery = (): MediaQueryList | undefined =>
  window.matchMedia?.("(prefers-color-scheme: dark)");

export const useHandleAppTheme = () => {
  const [appTheme, setAppTheme] = useState<Theme | "system">(() => {
    return (
      (localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME) as
        | Theme
        | "system"
        | null) || THEME.LIGHT
    );
  });
  const [editorTheme, setEditorTheme] = useState<Theme>(THEME.LIGHT);

  useLayoutEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, appTheme);

    if (appTheme === "system") {
      setEditorTheme(
        getDarkThemeMediaQuery()?.matches ? THEME.DARK : THEME.LIGHT,
      );
    } else {
      setEditorTheme(appTheme);
    }
  }, [appTheme]);

  return { editorTheme, appTheme, setAppTheme };
};
