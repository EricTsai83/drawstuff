import { describe, expect, it } from "vitest";
import {
  createPersistedWhiteboardDocumentV2,
  createWhiteboardDocumentV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  type WhiteboardAssetV2,
  type WhiteboardElementV2,
} from "@drawstuff/whiteboard/migration-v2";
import type {
  OwnedWhiteboardDocument,
  WhiteboardElementType,
} from "@drawstuff/whiteboard";
import { rectangleV3 } from "../whiteboard-fixtures";
import { saveSceneSchema } from "@/lib/schemas/scene";

const elementTypes = [
  "arrow",
  "diamond",
  "ellipse",
  "embeddable",
  "frame",
  "freedraw",
  "iframe",
  "image",
  "line",
  "magicframe",
  "rectangle",
  "text",
] as const satisfies readonly WhiteboardElementType[];

const assetMimeTypes = [
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jfif",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
] as const;

const earlierV2ElementFields = [
  "autoResize",
  "baseline",
  "boundElementIds",
  "boundElements",
  "containerId",
  "crop",
  "customData",
  "elbowed",
  "endArrowhead",
  "endBinding",
  "endIsSpecial",
  "fixedSegments",
  "fontFamily",
  "frameId",
  "groupIds",
  "hidden",
  "index",
  "lastCommittedPoint",
  "link",
  "name",
  "pressures",
  "polygon",
  "roundness",
  "scale",
  "seed",
  "simulatePressure",
  "startArrowhead",
  "startBinding",
  "startIsSpecial",
  "status",
  "strokeSharpness",
  "textAlign",
  "updated",
  "version",
  "versionNonce",
  "verticalAlign",
  "visible",
] as const;

function baseElement(
  id: string,
  type: WhiteboardElementType,
): Record<string, unknown> {
  return {
    id,
    type,
    isDeleted: false,
    x: 1,
    y: 2,
    width: 30,
    height: 40,
    angle: 0,
    strokeColor: "#111111",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 1,
    locked: false,
  };
}

function elementFor(type: WhiteboardElementType): WhiteboardElementV2 {
  const base = baseElement(type, type);
  if (type === "arrow" || type === "freedraw" || type === "line") {
    return {
      ...base,
      type,
      points: [
        [0, 0],
        [30, 40],
      ],
    } as unknown as WhiteboardElementV2;
  }
  if (type === "image") {
    return { ...base, type, fileId: "asset-inline" } as WhiteboardElementV2;
  }
  if (type === "text") {
    return {
      ...base,
      type,
      text: "V2",
      originalText: "V2",
      fontSize: 20,
      lineHeight: 1.25,
    } as WhiteboardElementV2;
  }
  return base as unknown as WhiteboardElementV2;
}

function inlineAsset(
  id = "asset-inline",
  mimeType = "image/png",
): WhiteboardAssetV2 {
  const sourceMimeType =
    mimeType === "application/octet-stream" ? "image/png" : mimeType;
  return {
    id,
    storage: "inline",
    mimeType: mimeType as WhiteboardAssetV2["mimeType"],
    dataURL: `data:${sourceMimeType};base64,AA==`,
    created: 1,
    lastRetrieved: 2,
    byteSize: 1,
    contentHash: "hash",
    width: 1,
    height: 1,
  };
}

function canonicalDocument() {
  return createWhiteboardDocumentV2({
    elements: elementTypes.map(elementFor),
    assets: {
      "asset-inline": inlineAsset(),
    },
    metadata: {
      name: "Canonical",
      theme: "dark",
      viewBackgroundColor: "#101010",
      gridSize: 20,
    },
  });
}

describe("WhiteboardDocumentV2", () => {
  it("round-trips every owned element variant deterministically", () => {
    const document = canonicalDocument();
    const first = serializeWhiteboardDocumentV2(document);
    const second = serializeWhiteboardDocumentV2({
      metadata: {
        theme: "dark",
        name: "Canonical",
        gridSize: 20,
        viewBackgroundColor: "#101010",
      },
      assets: { "asset-inline": inlineAsset() },
      elements: document.elements,
      version: 2,
    });

    expect(second).toBe(first);
    expect(parseWhiteboardDocumentV2(first)).toEqual(document);
    expect(new Set(document.elements.map((element) => element.type))).toEqual(
      new Set(elementTypes),
    );
  });

  it.each(assetMimeTypes)("accepts the inline %s asset variant", (mimeType) => {
    const asset = inlineAsset("asset-inline", mimeType);
    const document = createWhiteboardDocumentV2({
      elements: [elementFor("image")],
      assets: { "asset-inline": asset },
      metadata: {
        name: "Asset",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });

    expect(parseWhiteboardDocumentV2(document).assets["asset-inline"]).toEqual(
      asset,
    );
  });

  it("round-trips the external asset variant without embedded bytes", () => {
    const document = createWhiteboardDocumentV2({
      elements: [elementFor("image")],
      assets: {
        "asset-inline": {
          id: "asset-inline",
          storage: "external",
          mimeType: "image/png",
          created: 1,
        },
      },
      metadata: {
        name: "External",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    });
    const source = serializeWhiteboardDocumentV2(document);

    expect(parseWhiteboardDocumentV2(source)).toEqual(document);
    expect(source).not.toContain("dataURL");
  });

  it("reserves the opaque MIME type for external asset descriptors", () => {
    const document = canonicalDocument();
    const asset = inlineAsset("asset-inline", "application/octet-stream");

    expect(() =>
      parseWhiteboardDocumentV2({
        ...document,
        assets: { "asset-inline": asset },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_FIELD",
        path: "$.assets.asset-inline.mimeType",
      }),
    );
    expect(
      parseWhiteboardDocumentV2({
        ...document,
        assets: {
          "asset-inline": {
            id: "asset-inline",
            storage: "external",
            mimeType: "application/octet-stream",
            created: 1,
          },
        },
      }).assets["asset-inline"],
    ).toMatchObject({
      storage: "external",
      mimeType: "application/octet-stream",
    });
  });

  it.each([
    {
      payload: { ...canonicalDocument(), version: 3 },
      code: "UNSUPPORTED_VERSION",
      path: "$.version",
    },
    {
      payload: { ...canonicalDocument(), unsupportedRoot: true },
      code: "UNSUPPORTED_FIELD",
      path: "$.unsupportedRoot",
    },
    {
      payload: {
        ...canonicalDocument(),
        metadata: {
          ...canonicalDocument().metadata,
          unsupportedMetadata: true,
        },
      },
      code: "UNSUPPORTED_FIELD",
      path: "$.metadata.unsupportedMetadata",
    },
    {
      payload: {
        ...canonicalDocument(),
        elements: [
          {
            ...baseElement("future", "rectangle"),
            type: "future-element",
          },
        ],
      },
      code: "UNSUPPORTED_ELEMENT",
      path: "$.elements[0].type",
    },
    {
      payload: {
        ...canonicalDocument(),
        elements: [
          {
            ...baseElement("infinite", "rectangle"),
            x: Number.POSITIVE_INFINITY,
          },
        ],
      },
      code: "MALFORMED_DOCUMENT",
      path: "$.elements[0].x",
    },
    {
      payload: {
        ...canonicalDocument(),
        elements: [
          {
            ...baseElement("future-field", "rectangle"),
            futureData: true,
          },
        ],
      },
      code: "UNSUPPORTED_FIELD",
      path: "$.elements[0].futureData",
    },
    {
      payload: {
        ...canonicalDocument(),
        elements: [
          {
            ...baseElement("missing", "image"),
            type: "image",
            fileId: "missing",
          },
        ],
        assets: {},
      },
      code: "MISSING_ASSET",
      path: "$.elements[0].fileId",
    },
  ])(
    "rejects invalid canonical input with $code",
    ({ payload, code, path }) => {
      expect(() => parseWhiteboardDocumentV2(payload)).toThrowError(
        expect.objectContaining({ code, path }),
      );
    },
  );

  it("strips properties emitted by earlier V2 writers", () => {
    const document = parseWhiteboardDocumentV2({
      ...canonicalDocument(),
      elements: [
        {
          ...baseElement("earlier-v2", "rectangle"),
          ...Object.fromEntries(
            earlierV2ElementFields.map((field) => [field, null]),
          ),
        },
      ],
    });

    expect(document.elements[0]).toEqual(
      baseElement("earlier-v2", "rectangle"),
    );
    const serialized = JSON.parse(serializeWhiteboardDocumentV2(document)) as {
      elements: Array<Record<string, unknown>>;
    };
    for (const field of earlierV2ElementFields) {
      expect(field in serialized.elements[0]!).toBe(false);
    }
  });

  it("keeps editor session state out of writes", () => {
    const runtime: OwnedWhiteboardDocument = {
      elements: [rectangleV3("shape")],
      assets: {},
      state: {
        name: "Runtime",
        theme: "light",
        scrollX: 100,
        scrollY: 200,
        zoom: { value: 0.5 },
        openDialog: null,
      },
    };
    const source = serializeWhiteboardDocumentV2(
      createPersistedWhiteboardDocumentV2(runtime),
    );

    expect(source).not.toContain("scrollX");
    expect(source).not.toContain("openDialog");
  });

  it("requires the explicit current version in the save API", () => {
    const base = {
      name: "Saved",
      data: "compressed",
    };
    expect(
      saveSceneSchema.safeParse({ ...base, documentVersion: 3 }).success,
    ).toBe(true);
    expect(saveSceneSchema.safeParse(base).success).toBe(false);
    expect(
      saveSceneSchema.safeParse({ ...base, documentVersion: 1 }).success,
    ).toBe(false);
  });
});
