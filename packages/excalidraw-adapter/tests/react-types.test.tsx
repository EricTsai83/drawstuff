import type { ReactElement } from "react";
import { expect, it } from "vitest";

import type {
  ExcalidrawCanvasProps,
  ExcalidrawValidateEmbeddable,
} from "../src/types";

const validateEmbeddable: ExcalidrawValidateEmbeddable = (url: string) =>
  url.startsWith("https://example.com/") ? true : undefined;

const editorProps = {
  initialData: Promise.resolve(null),
  langCode: "en",
  renderTopRightUI: () => null,
  theme: "dark",
  UIOptions: {
    canvasActions: {
      export: false,
      toggleTheme: true,
    },
  },
  validateEmbeddable,
} satisfies ExcalidrawCanvasProps;

const createTypecheckedElement = (): ReactElement => (
  <div data-adapter-typecheck={editorProps.theme} />
);

it("typechecks the approved canvas prop contract", () => {
  expect(createTypecheckedElement().type).toBe("div");
});
