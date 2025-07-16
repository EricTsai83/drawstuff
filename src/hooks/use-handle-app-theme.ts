import { THEME } from "@excalidraw/excalidraw";
import { useLayoutEffect, useState } from "react";

import type { Theme } from "@excalidraw/excalidraw/element/types";

import { STORAGE_KEYS } from "@/config/app-constants";

// 如果 appTheme 是 "system"：
// 檢查系統偏好（prefers-color-scheme: dark）
// 系統偏好深色 → editorTheme = "dark"
// 系統偏好淺色 → editorTheme = "light"
// 如果 appTheme 是 "light" 或 "dark"：
// 直接使用：editorTheme = appTheme
// => editorTheme 是最終決定顏色模式的人

const getDarkThemeMediaQuery = (): MediaQueryList | undefined =>
  window.matchMedia?.("(prefers-color-scheme: dark)");

export const useHandleAppTheme = () => {
  const [appTheme, setAppTheme] = useState<Theme | "system">(() => {
    return (
      (localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME) as
        | Theme
        | "system"
        | null) ?? THEME.LIGHT
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
