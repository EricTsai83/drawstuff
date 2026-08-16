// @vitest-environment jsdom

import { Excalidraw } from "@excalidraw/excalidraw";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXCALIDRAW_LANGUAGE,
  ExcalidrawCanvas,
  ExcalidrawDefaultSidebar,
  ExcalidrawFooter,
  EXCALIDRAW_LANGUAGES,
  ExcalidrawMainMenu,
  EXCALIDRAW_MIME_TYPES,
  ExcalidrawStats,
  EXCALIDRAW_THEME,
  ExcalidrawWelcomeScreen,
  exportCanvasToBlob,
  restoreScene,
  restoreExcalidrawLibraryItems,
  useExcalidrawLibrary,
  useExcalidrawI18n,
} from "../src/client.ts";

describe("real upstream client surface", () => {
  it("loads every approved runtime export and the stylesheet subpath", () => {
    expect([
      DEFAULT_EXCALIDRAW_LANGUAGE,
      ExcalidrawDefaultSidebar,
      ExcalidrawFooter,
      EXCALIDRAW_LANGUAGES,
      ExcalidrawMainMenu,
      EXCALIDRAW_MIME_TYPES,
      ExcalidrawStats,
      EXCALIDRAW_THEME,
      ExcalidrawWelcomeScreen,
      exportCanvasToBlob,
      restoreScene,
      restoreExcalidrawLibraryItems,
      useExcalidrawLibrary,
      useExcalidrawI18n,
    ]).not.toContain(undefined);
  });

  it("wraps the real upstream Excalidraw component", () => {
    expect(ExcalidrawCanvas({}).type).toBe(Excalidraw);
  });
});
