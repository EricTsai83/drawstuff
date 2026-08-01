import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({
  Excalidraw: vi.fn(({ children }: { children?: ReactNode }) => (
    <div data-testid="canvas">{children}</div>
  )),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  defaultLang: { code: "en" },
  Excalidraw: upstream.Excalidraw,
  exportToBlob: vi.fn(),
  Footer: "footer",
  languages: [{ code: "en" }],
  MainMenu: "menu",
  MIME_TYPES: { png: "image/png" },
  restore: vi.fn(),
  serializeAsJSON: vi.fn(),
  Stats: {},
  THEME: { DARK: "dark", LIGHT: "light" },
  useI18n: vi.fn(),
  WelcomeScreen: "welcome",
}));

import { ExcalidrawCanvas } from "../src/client";

describe("ExcalidrawCanvas", () => {
  it("renders children and forwards the approved editor props unchanged", () => {
    const onApi = vi.fn<(api: ExcalidrawImperativeAPI) => void>();
    const initialData = Promise.resolve(null);
    const uiOptions = {
      canvasActions: {
        toggleTheme: true,
      },
    };
    const validateEmbeddable = vi.fn<(url: string) => boolean | undefined>();
    const element = ExcalidrawCanvas({
      children: <span>menu slot</span>,
      excalidrawAPI: onApi,
      initialData,
      langCode: "en",
      theme: "dark",
      UIOptions: uiOptions,
      validateEmbeddable,
      viewModeEnabled: true,
    });

    expect(renderToStaticMarkup(element)).toContain("menu slot");
    expect(upstream.Excalidraw).toHaveBeenCalledWith(
      expect.objectContaining({
        excalidrawAPI: onApi,
        initialData,
        langCode: "en",
        theme: "dark",
        UIOptions: uiOptions,
        validateEmbeddable,
        viewModeEnabled: true,
      }),
      undefined,
    );
  });

  it("preserves the imperative API callback identity", () => {
    const onApi = vi.fn<(api: ExcalidrawImperativeAPI) => void>();
    const element = ExcalidrawCanvas({ excalidrawAPI: onApi });
    const api = {} as ExcalidrawImperativeAPI;

    element.props.excalidrawAPI?.(api);

    expect(onApi).toHaveBeenCalledOnce();
    expect(onApi).toHaveBeenCalledWith(api);
  });
});
