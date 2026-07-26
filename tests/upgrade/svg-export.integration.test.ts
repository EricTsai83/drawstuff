import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportToSvg, restore } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  NonDeleted,
} from "@excalidraw/excalidraw/element/types";

type SceneFixture = {
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

describe("native Excalidraw SVG export", () => {
  it("renders the stable shapes-and-text fixture as SVG", async () => {
    const source = await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/legacy-scenes/shapes-and-text.excalidraw",
      ),
      "utf8",
    );
    const fixture = JSON.parse(source) as SceneFixture;
    const restored = restore(fixture, null, null, {
      repairBindings: true,
      refreshDimensions: false,
    });

    const elements = restored.elements.filter(
      (element): element is NonDeleted<typeof element> => !element.isDeleted,
    );
    type ExportToSvgFn = (options: {
      elements: readonly NonDeleted<ExcalidrawElement>[];
      appState: Partial<AppState>;
      files: BinaryFiles;
    }) => Promise<SVGSVGElement>;
    // See src/lib/excalidraw.ts: the 0.18.0 package declaration points at an
    // unresolved internal alias, while this test still invokes the real export.
    const exportToSvgTyped = exportToSvg as unknown as ExportToSvgFn;
    const svg = await exportToSvgTyped({
      elements,
      appState: restored.appState,
      files: restored.files,
    });

    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.querySelectorAll("text").length).toBeGreaterThan(0);
  });
});
