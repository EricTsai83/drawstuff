import { describe, expect, it, vi } from "vitest";
import type {
  WhiteboardAsset,
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@/features/whiteboard";
import {
  exportOwnedWhiteboardDocument,
  exportOwnedWhiteboardImage,
  exportOwnedWhiteboardSvg,
} from "@/features/whiteboard/owned";

describe("owned whiteboard export", () => {
  it("exports stable device-independent bounds without editor overlays", () => {
    const svg = exportOwnedWhiteboardSvg(
      createDocument([
        rectangle("shape"),
        {
          ...rectangle("deleted"),
          isDeleted: true,
          x: 1000,
        },
      ]),
      { format: "svg", exportPadding: 10 },
    );

    expect(svg).toContain('width="120" height="70" viewBox="0 0 120 70"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain("<rect");
    expect(svg).not.toContain("deleted");
    expect(svg).not.toContain("selection");
  });

  it("escapes text and replaces unsafe, missing, or external images", () => {
    const unsafeSvg: WhiteboardAsset = {
      id: "unsafe",
      dataURL:
        "data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E",
      mimeType: "image/svg+xml",
      created: 1,
    };
    const svg = exportOwnedWhiteboardSvg(
      createDocument(
        [
          {
            ...rectangle("text"),
            type: "text",
            text: `<script>alert("x")</script> & safe`,
            originalText: `<script>alert("x")</script> & safe`,
            fontSize: 20,
            lineHeight: 1.25,
          },
          {
            ...rectangle("image"),
            type: "image",
            fileId: "unsafe",
          },
          {
            ...rectangle("missing"),
            type: "image",
            fileId: "missing",
          },
        ],
        { unsafe: unsafeSvg },
      ),
      { format: "svg", background: false },
    );

    expect(svg).toContain('&lt;script&gt;alert("x")&lt;/script&gt; &amp; safe');
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("href=");
    expect(svg.match(/data-missing-asset="true"/g)).toHaveLength(2);
    expect(svg).not.toContain('width="100%"');
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
  });

  it("supports selection-only export and prunes document assets after references", async () => {
    const referenced = asset("referenced");
    const unused = asset("unused");
    const source = createDocument(
      [
        {
          ...rectangle("first"),
          text: "FIRST",
          originalText: "FIRST",
          fontSize: 20,
          lineHeight: 1.25,
          type: "text",
        },
        {
          ...rectangle("second"),
          x: 200,
          text: "SECOND",
          originalText: "SECOND",
          fontSize: 20,
          lineHeight: 1.25,
          type: "text",
        },
        {
          ...rectangle("image"),
          type: "image",
          fileId: referenced.id,
        },
      ],
      { referenced, unused },
    );
    const svg = exportOwnedWhiteboardSvg(
      source,
      { format: "svg", selectionOnly: true },
      ["second"],
    );
    const exported = JSON.parse(
      await exportOwnedWhiteboardDocument(source).text(),
    ) as {
      readonly version: number;
      readonly assets: Readonly<Record<string, WhiteboardAsset>>;
    };

    expect(svg).toContain("SECOND");
    expect(svg).not.toContain("FIRST");
    expect(exported.version).toBe(2);
    expect(Object.keys(exported.assets)).toEqual(["referenced"]);
  });

  it("keeps referenced raster assets in the portable document", async () => {
    const rasterAssets = Object.fromEntries(
      [
        "image/bmp",
        "image/jfif",
        "image/vnd.microsoft.icon",
        "image/x-icon",
      ].map((mimeType, index) => {
        const id = `raster-${index}`;
        return [
          id,
          {
            id,
            dataURL: `data:${mimeType};base64,AA==`,
            mimeType,
            created: 1,
          },
        ];
      }),
    );
    const exported = JSON.parse(
      await exportOwnedWhiteboardDocument(
        createDocument(
          Object.keys(rasterAssets).map((fileId) => ({
            ...rectangle(`image-${fileId}`),
            type: "image",
            fileId,
          })),
          rasterAssets,
        ),
      ).text(),
    ) as { readonly assets: Readonly<Record<string, WhiteboardAsset>> };

    expect(Object.keys(exported.assets)).toEqual(Object.keys(rasterAssets));
  });

  it("exports dangling image references as portable placeholders", async () => {
    const exported = JSON.parse(
      await exportOwnedWhiteboardDocument(
        createDocument([
          {
            ...rectangle("missing-image"),
            type: "image",
            fileId: "missing",
          },
        ]),
      ).text(),
    ) as { readonly elements: readonly WhiteboardElement[] };

    expect(exported.elements[0]?.type).toBe("image");
    expect(
      exported.elements[0]?.type === "image"
        ? exported.elements[0].fileId
        : undefined,
    ).toBeNull();
  });

  it("rasterizes PNG at configurable scale and cap", async () => {
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, type?: string) =>
      callback(new Blob(["png"], { type })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(toBlob);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:owned-export"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    class LoadedImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);

    const blob = await exportOwnedWhiteboardImage(
      createDocument([rectangle("png")]),
      {
        format: "png",
        scale: 3,
        maxWidthOrHeight: 240,
        exportPadding: 10,
      },
    );

    expect(blob.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(LoadedImage),
      0,
      0,
      240,
      140,
    );
    expect(toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/png",
      undefined,
    );

    await exportOwnedWhiteboardImage(
      createDocument([{ ...rectangle("wide"), width: 100_000 }]),
      { format: "png", scale: 3, exportPadding: 10 },
    );
    expect(drawImage).toHaveBeenLastCalledWith(
      expect.any(LoadedImage),
      0,
      0,
      16_384,
      11,
    );
  });
});

function createDocument(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>> = {},
): OwnedWhiteboardDocument {
  return {
    elements,
    assets,
    state: {
      name: "Export fixture",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}

function rectangle(id: string): WhiteboardElement {
  return {
    id,
    type: "rectangle",
    isDeleted: false,
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 1,
    locked: false,
  };
}

function asset(id: string): WhiteboardAsset {
  return {
    id,
    dataURL: "data:image/png;base64,AA==",
    mimeType: "image/png",
    created: 1,
  };
}
