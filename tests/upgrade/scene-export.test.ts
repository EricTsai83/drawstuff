import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type * as ExcalidrawModule from "@excalidraw/excalidraw";
import type { WhiteboardDocument } from "@/features/whiteboard";

const exportMocks = vi.hoisted(() => ({
  blob: vi.fn(),
  svg: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", async (importOriginal) => {
  const actual = await importOriginal<typeof ExcalidrawModule>();
  return {
    ...actual,
    exportToBlob: exportMocks.blob,
    exportToSvg: exportMocks.svg,
  };
});

import { exportSceneToPngBlob } from "@/lib/excalidraw";
import {
  exportExcalidrawDocument,
  exportExcalidrawImage,
} from "@/features/whiteboard/adapters/excalidraw/exporters";

const visibleElement = {
  id: "visible",
  type: "rectangle",
  isDeleted: false,
} as ExcalidrawElement;

const deletedElement = {
  id: "deleted",
  type: "rectangle",
  isDeleted: true,
} as ExcalidrawElement;

describe("PNG and SVG export contracts", () => {
  beforeEach(() => {
    exportMocks.blob.mockReset();
    exportMocks.svg.mockReset();
  });

  it("exports PNG with deleted elements removed and dark background enabled", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    exportMocks.blob.mockResolvedValue(blob);

    const result = await exportSceneToPngBlob(
      [visibleElement, deletedElement],
      { theme: "dark" },
      {},
      { quality: 0.9, exportPadding: 24 },
    );

    expect(result).toBe(blob);
    const pngOptions: unknown = exportMocks.blob.mock.calls[0]?.[0];
    expect(pngOptions).toMatchObject({
      elements: [visibleElement],
      files: {},
      mimeType: "image/png",
      quality: 0.9,
      exportPadding: 24,
      appState: {
        theme: "dark",
        exportBackground: true,
        exportWithDarkMode: true,
      },
    });
  });

  it("delegates adapter PNG export through the existing product export behavior", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    exportMocks.blob.mockResolvedValue(blob);
    const document: WhiteboardDocument = {
      elements: [visibleElement],
      state: { name: "Adapter export", theme: "dark" },
      assets: {},
    };

    await expect(
      exportExcalidrawImage(document, {
        format: "png",
        quality: 0.8,
        exportPadding: 16,
      }),
    ).resolves.toBe(blob);
    const adapterPngOptions: unknown = exportMocks.blob.mock.calls[0]?.[0];
    expect(adapterPngOptions).toMatchObject({
      elements: [visibleElement],
      files: {},
      mimeType: "image/png",
      quality: 0.8,
      exportPadding: 16,
      appState: {
        name: "Adapter export",
        theme: "dark",
        exportBackground: true,
        exportWithDarkMode: true,
      },
    });
  });

  it("exports SVG and the unchanged legacy Excalidraw document payload", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    exportMocks.svg.mockResolvedValue(svg);
    const whiteboardDocument: WhiteboardDocument = {
      elements: [visibleElement],
      state: { name: "Portable", theme: "light" },
      assets: {},
    };

    const svgBlob = await exportExcalidrawImage(whiteboardDocument, {
      format: "svg",
      exportPadding: 20,
    });
    expect(svgBlob.type).toBe("image/svg+xml");
    expect(exportMocks.svg).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [visibleElement],
        files: {},
        exportPadding: 20,
      }),
    );

    const documentBlob = await exportExcalidrawDocument(whiteboardDocument);
    expect(documentBlob.type).toBe("application/json");
    await expect(documentBlob.text()).resolves.toBe(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw-ericts.vercel.app",
        elements: [visibleElement],
        appState: whiteboardDocument.state,
        files: {},
      }),
    );
  });
});
