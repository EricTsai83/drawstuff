"use client";

import "@excalidraw/excalidraw/index.css";

import {
  defaultLang,
  Excalidraw,
  exportToBlob,
  Footer,
  languages,
  MainMenu,
  MIME_TYPES,
  restore,
  Stats,
  THEME,
  useI18n,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import { createElement, type ReactElement } from "react";

import type { ExcalidrawCanvasProps } from "./types.ts";

export function ExcalidrawCanvas(
  props: ExcalidrawCanvasProps,
): ReactElement<ExcalidrawCanvasProps> {
  return createElement(Excalidraw, props);
}

export {
  defaultLang as DEFAULT_EXCALIDRAW_LANGUAGE,
  exportToBlob as exportCanvasToBlob,
  Footer as ExcalidrawFooter,
  languages as EXCALIDRAW_LANGUAGES,
  MainMenu as ExcalidrawMainMenu,
  MIME_TYPES as EXCALIDRAW_MIME_TYPES,
  restore as restoreScene,
  Stats as ExcalidrawStats,
  THEME as EXCALIDRAW_THEME,
  useI18n as useExcalidrawI18n,
  WelcomeScreen as ExcalidrawWelcomeScreen,
};
