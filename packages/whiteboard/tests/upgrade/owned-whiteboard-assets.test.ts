import { describe, expect, it } from "vitest";
import type {
  WhiteboardAsset,
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@drawstuff/whiteboard";
import {
  importWhiteboardImage,
  isSafeInlineImage,
  pruneUnreferencedWhiteboardAssets,
  resolveWhiteboardAssets,
  WhiteboardAssetError,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../helpers";

describe("owned whiteboard assets", () => {
  it("validates image headers, records metadata, and deduplicates exact content", async () => {
    const first = await importWhiteboardImage(
      new Blob([pngBytes(320, 180)], { type: "image/png" }),
      {},
      { now: () => 42 },
    );
    const duplicate = await importWhiteboardImage(
      new Blob([pngBytes(320, 180)], { type: "image/png" }),
      { [first.asset.id]: first.asset },
    );
    const distinct = await importWhiteboardImage(
      new Blob(
        [new Uint8Array([...new Uint8Array(pngBytes(320, 180)), 1]).buffer],
        {
          type: "image/png",
        },
      ),
      { [first.asset.id]: first.asset },
    );

    expect(first).toMatchObject({
      deduplicated: false,
      width: 320,
      height: 180,
      asset: {
        byteSize: 24,
        created: 42,
        height: 180,
        mimeType: "image/png",
        width: 320,
      },
    });
    expect(first.asset.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(duplicate).toMatchObject({
      deduplicated: true,
      asset: { id: first.asset.id },
    });
    expect(distinct.asset.id).not.toBe(first.asset.id);
  });

  it("accepts JPEG fill bytes and standalone markers before the size segment", async () => {
    const imported = await importWhiteboardImage(
      new Blob([jpegBytesWithFillMarkers(20, 10)], { type: "image/jpeg" }),
      {},
    );

    expect(imported).toMatchObject({ width: 20, height: 10 });
  });

  it.each([
    {
      name: "empty",
      blob: new Blob([], { type: "image/png" }),
      options: undefined,
      code: "EMPTY_IMAGE",
    },
    {
      name: "oversized",
      blob: new Blob([pngBytes(1, 1)], { type: "image/png" }),
      options: { maxBytes: 10 },
      code: "IMAGE_TOO_LARGE",
    },
    {
      name: "oversized decoded dimensions",
      blob: new Blob([pngBytes(9000, 1)], { type: "image/png" }),
      options: undefined,
      code: "IMAGE_TOO_LARGE",
    },
    {
      name: "unsupported",
      blob: new Blob(["<svg/>"], { type: "image/svg+xml" }),
      options: undefined,
      code: "UNSUPPORTED_IMAGE_TYPE",
    },
    {
      name: "corrupt",
      blob: new Blob(["not a png"], { type: "image/png" }),
      options: undefined,
      code: "CORRUPT_IMAGE",
    },
  ])("rejects $name image payloads", async ({ blob, options, code }) => {
    await expect(
      importWhiteboardImage(blob, {}, options),
    ).rejects.toMatchObject({
      name: WhiteboardAssetError.name,
      code,
    });
  });

  it("resolves referenced payloads by source priority without merging ID collisions", () => {
    const local = asset("shared", "AA==");
    const database = asset("shared", "AQ==");
    const unreferenced = asset("unused", "Ag==");
    const elements = [image("image", "shared")];

    expect(
      resolveWhiteboardAssets(
        elements,
        { shared: local },
        { shared: database, unused: unreferenced },
      ),
    ).toEqual({ shared: local });

    const document: OwnedWhiteboardDocument = {
      elements,
      assets: { shared: local, unused: unreferenced },
      state: {},
    };
    expect(pruneUnreferencedWhiteboardAssets(document).assets).toEqual({
      shared: local,
    });
  });

  it("allows safe same-document SVG references but rejects external references", () => {
    const svgAsset = (svg: string): WhiteboardAsset => ({
      id: "svg",
      dataURL: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      mimeType: "image/svg+xml",
      created: 1,
    });

    expect(
      isSafeInlineImage(
        svgAsset(
          '<svg><defs><clipPath id="clip0"><rect/></clipPath></defs><g clip-path="url(#clip0)"/></svg>',
        ),
      ),
    ).toBe(true);
    expect(
      isSafeInlineImage(
        svgAsset(
          '<svg><rect fill="url(https://attacker.example/a.svg)"/></svg>',
        ),
      ),
    ).toBe(false);
  });

  it.each([
    "image/bmp",
    "image/jfif",
    "image/vnd.microsoft.icon",
    "image/x-icon",
  ])("keeps supported %s raster payloads renderable", (mimeType) => {
    expect(
      isSafeInlineImage({
        id: mimeType,
        dataURL: `data:${mimeType};base64,AA==`,
        mimeType,
        created: 1,
      }),
    ).toBe(true);
  });
});

function pngBytes(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.buffer;
}

function jpegBytesWithFillMarkers(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xff,
    0x01,
    0xff,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  return bytes.buffer;
}

function asset(id: string, payload: string): WhiteboardAsset {
  return {
    id,
    dataURL: `data:image/png;base64,${payload}`,
    mimeType: "image/png",
    created: 1,
  };
}

function image(id: string, fileId: string): WhiteboardElement {
  return createTestElementV3({
    id,
    type: "image",
    isDeleted: false,
    fileId,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    locked: false,
  });
}
