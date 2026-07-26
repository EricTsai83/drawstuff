import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type * as ExcalidrawModule from "@excalidraw/excalidraw";

const exportMocks = vi.hoisted(() => ({
  blob: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", async (importOriginal) => {
  const actual = await importOriginal<typeof ExcalidrawModule>();
  return {
    ...actual,
    exportToBlob: exportMocks.blob,
  };
});

import { exportSceneToPngBlob } from "@/lib/excalidraw";

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
});
