import type {
  WhiteboardAsset,
  WhiteboardAssetMimeTypeV2,
  WhiteboardAssetV2,
  WhiteboardDocument,
  WhiteboardDocumentMetadataV2,
  WhiteboardDocumentV2,
  WhiteboardElement,
  WhiteboardElementType,
  WhiteboardElementV2,
  WhiteboardFillStyle,
  WhiteboardStrokeStyle,
  WhiteboardTheme,
} from "./contracts";
import { WhiteboardDocumentError } from "./document-errors";

export const WHITEBOARD_DOCUMENT_VERSION = 2 as const;

const ELEMENT_TYPES = new Set<WhiteboardElementType>([
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
]);

const LINEAR_ELEMENT_TYPES = new Set<WhiteboardElementType>([
  "arrow",
  "freedraw",
  "line",
]);

const ASSET_MIME_TYPES = new Set<WhiteboardAssetMimeTypeV2>([
  "application/octet-stream",
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
]);

const ROOT_FIELDS = new Set(["assets", "elements", "metadata", "version"]);
const METADATA_FIELDS = new Set([
  "gridSize",
  "name",
  "theme",
  "viewBackgroundColor",
]);
const ASSET_FIELDS = new Set([
  "byteSize",
  "contentHash",
  "created",
  "dataURL",
  "height",
  "id",
  "lastRetrieved",
  "mimeType",
  "storage",
  "width",
]);

/**
 * Compatibility properties are retained as element-level data because the
 * owned renderer and editing engine already preserve them across operations.
 * Transition envelopes and source payloads are deliberately absent.
 */
const ELEMENT_FIELDS = new Set([
  "angle",
  "autoResize",
  "backgroundColor",
  "boundElementIds",
  "boundElements",
  "containerId",
  "crop",
  "customData",
  "elbowed",
  "endArrowhead",
  "endBinding",
  "endIsSpecial",
  "fileId",
  "fillStyle",
  "fixedSegments",
  "fontFamily",
  "fontSize",
  "frameId",
  "groupIds",
  "height",
  "hidden",
  "id",
  "index",
  "isDeleted",
  "lastCommittedPoint",
  "lineHeight",
  "link",
  "locked",
  "name",
  "opacity",
  "originalText",
  "points",
  "pressures",
  "roughness",
  "roundness",
  "scale",
  "seed",
  "simulatePressure",
  "startArrowhead",
  "startBinding",
  "startIsSpecial",
  "status",
  "strokeColor",
  "strokeSharpness",
  "strokeStyle",
  "strokeWidth",
  "text",
  "textAlign",
  "type",
  "updated",
  "version",
  "versionNonce",
  "verticalAlign",
  "visible",
  "width",
  "x",
  "y",
]);

const CORE_ELEMENT_FIELDS = new Set([
  "angle",
  "backgroundColor",
  "fileId",
  "fillStyle",
  "fontSize",
  "height",
  "id",
  "isDeleted",
  "lineHeight",
  "locked",
  "opacity",
  "originalText",
  "points",
  "roughness",
  "strokeColor",
  "strokeStyle",
  "strokeWidth",
  "text",
  "type",
  "width",
  "x",
  "y",
]);

type JsonObject = Readonly<Record<string, unknown>>;

export function parseWhiteboardDocumentV2(
  payload: unknown,
): WhiteboardDocumentV2 {
  const object = expectObject(parseJsonInput(payload), "$");
  assertOnlyFields(object, ROOT_FIELDS, "$");
  if (object.version !== WHITEBOARD_DOCUMENT_VERSION) {
    throw new WhiteboardDocumentError(
      typeof object.version === "number"
        ? "UNSUPPORTED_VERSION"
        : "MALFORMED_DOCUMENT",
      `Expected whiteboard document version ${WHITEBOARD_DOCUMENT_VERSION}`,
      "$.version",
    );
  }

  const elements = parseElements(object.elements);
  const assets = parseAssets(object.assets);
  const metadata = parseMetadata(object.metadata);
  assertReferencedAssetsExist(elements, assets);
  return {
    version: WHITEBOARD_DOCUMENT_VERSION,
    elements,
    assets,
    metadata,
  };
}

export function createWhiteboardDocumentV2({
  elements,
  assets,
  metadata,
}: Omit<WhiteboardDocumentV2, "version">): WhiteboardDocumentV2 {
  return parseWhiteboardDocumentV2({
    version: WHITEBOARD_DOCUMENT_VERSION,
    elements,
    assets,
    metadata,
  });
}

export function serializeWhiteboardDocumentV2(
  document: WhiteboardDocumentV2,
): string {
  return stableStringify(parseWhiteboardDocumentV2(document));
}

export function createPersistedWhiteboardDocumentV2(
  document: WhiteboardDocument,
  options?: {
    readonly assetStorage?: "external" | "inline";
    /**
     * Conversion-only escape hatch for old cloud rows whose asset metadata
     * lives exclusively in file_record. New writers must provide every asset.
     */
    readonly externalAssetIds?: ReadonlySet<string>;
  },
): WhiteboardDocumentV2 {
  const elements = document.elements.map((element, index) =>
    normalizeRuntimeElement(element, index),
  );
  const referencedAssetIds = new Set(
    elements.flatMap((element) =>
      !element.isDeleted && element.type === "image" && element.fileId !== null
        ? [element.fileId]
        : [],
    ),
  );
  const assetStorage = options?.assetStorage ?? "inline";
  const assets = Object.fromEntries(
    [...referencedAssetIds].sort().map((id) => {
      const asset = document.assets[id];
      if (!asset) {
        if (options?.externalAssetIds?.has(id)) {
          return [
            id,
            {
              id,
              storage: "external" as const,
              mimeType: "application/octet-stream" as const,
              created: 0,
            },
          ] as const;
        }
        throw new WhiteboardDocumentError(
          "MISSING_ASSET",
          `Image element references missing asset ${id}`,
          "$.assets",
        );
      }
      return [id, createPersistedAsset(asset, assetStorage)] as const;
    }),
  );

  return createWhiteboardDocumentV2({
    elements,
    assets,
    metadata: metadataFromRuntime(document),
  });
}

export function externalizeWhiteboardDocumentAssetsV2(
  document: WhiteboardDocumentV2,
): WhiteboardDocumentV2 {
  const parsed = parseWhiteboardDocumentV2(document);
  return createWhiteboardDocumentV2({
    ...parsed,
    assets: Object.fromEntries(
      Object.entries(parsed.assets).map(([id, asset]) => [
        id,
        {
          ...asset,
          storage: "external" as const,
          dataURL: undefined,
        },
      ]),
    ),
  });
}

export function toRuntimeWhiteboardDocumentV2(
  document: WhiteboardDocumentV2,
): WhiteboardDocument {
  const parsed = parseWhiteboardDocumentV2(document);
  return {
    elements: parsed.elements,
    assets: Object.fromEntries(
      Object.entries(parsed.assets).flatMap(([id, asset]) =>
        asset.storage === "inline"
          ? [
              [
                id,
                {
                  id: asset.id,
                  dataURL: asset.dataURL,
                  mimeType: asset.mimeType,
                  created: asset.created,
                  ...(asset.lastRetrieved === undefined
                    ? {}
                    : { lastRetrieved: asset.lastRetrieved }),
                  ...(asset.byteSize === undefined
                    ? {}
                    : { byteSize: asset.byteSize }),
                  ...(asset.contentHash === undefined
                    ? {}
                    : { contentHash: asset.contentHash }),
                  ...(asset.width === undefined ? {} : { width: asset.width }),
                  ...(asset.height === undefined
                    ? {}
                    : { height: asset.height }),
                } satisfies WhiteboardAsset,
              ] as const,
            ]
          : [],
      ),
    ),
    state: {
      name: parsed.metadata.name,
      theme: parsed.metadata.theme,
      viewBackgroundColor: parsed.metadata.viewBackgroundColor,
      gridSize: parsed.metadata.gridSize,
    },
    persistence: {
      sourceFormat: "whiteboard-v2",
      documentVersion: WHITEBOARD_DOCUMENT_VERSION,
    },
  };
}

function parseElements(value: unknown): WhiteboardElementV2[] {
  if (!Array.isArray(value)) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected an elements array",
      "$.elements",
    );
  }
  const ids = new Set<string>();
  return value.map((value, index) => {
    const path = `$.elements[${index}]`;
    const object = expectObject(value, path);
    assertOnlyFields(object, ELEMENT_FIELDS, path);
    assertJsonValue(object, path);
    const id = expectNonEmptyString(object.id, `${path}.id`);
    if (ids.has(id)) {
      throw new WhiteboardDocumentError(
        "MALFORMED_DOCUMENT",
        `Duplicate element id ${id}`,
        `${path}.id`,
      );
    }
    ids.add(id);
    const type = parseElementType(object.type, `${path}.type`);
    assertElementVariantFields(object, type, path);
    const base = {
      ...cloneJson(object),
      id,
      type,
      isDeleted: expectBoolean(object.isDeleted, `${path}.isDeleted`),
      x: expectFiniteNumber(object.x, `${path}.x`),
      y: expectFiniteNumber(object.y, `${path}.y`),
      width: expectFiniteNumber(object.width, `${path}.width`),
      height: expectFiniteNumber(object.height, `${path}.height`),
      angle: expectFiniteNumber(object.angle, `${path}.angle`),
      strokeColor: expectString(object.strokeColor, `${path}.strokeColor`),
      backgroundColor: expectString(
        object.backgroundColor,
        `${path}.backgroundColor`,
      ),
      fillStyle: parseFillStyle(object.fillStyle, `${path}.fillStyle`),
      strokeWidth: expectNonNegativeNumber(
        object.strokeWidth,
        `${path}.strokeWidth`,
      ),
      strokeStyle: parseStrokeStyle(object.strokeStyle, `${path}.strokeStyle`),
      opacity: expectRange(object.opacity, 0, 100, `${path}.opacity`),
      roughness: expectNonNegativeNumber(object.roughness, `${path}.roughness`),
      locked: expectBoolean(object.locked, `${path}.locked`),
    };
    if (isLinearElementType(type)) {
      return {
        ...base,
        type,
        points: parsePoints(object.points, `${path}.points`),
      };
    }
    if (type === "image") {
      return {
        ...base,
        type,
        fileId:
          object.fileId === null
            ? null
            : expectNonEmptyString(object.fileId, `${path}.fileId`),
      };
    }
    if (type === "text") {
      return {
        ...base,
        type,
        text: expectString(object.text, `${path}.text`),
        originalText: expectString(object.originalText, `${path}.originalText`),
        fontSize: expectPositiveNumber(object.fontSize, `${path}.fontSize`),
        lineHeight: expectPositiveNumber(
          object.lineHeight,
          `${path}.lineHeight`,
        ),
      };
    }
    return base as WhiteboardElementV2;
  });
}

function parseAssets(
  value: unknown,
): Readonly<Record<string, WhiteboardAssetV2>> {
  const object = expectObject(value, "$.assets");
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, value]): readonly [string, WhiteboardAssetV2] => {
        const path = `$.assets.${escapePathSegment(key)}`;
        const asset = expectObject(value, path);
        assertOnlyFields(asset, ASSET_FIELDS, path);
        const id = expectNonEmptyString(asset.id, `${path}.id`);
        if (id !== key) {
          throw new WhiteboardDocumentError(
            "MALFORMED_DOCUMENT",
            `Asset id ${id} does not match record key ${key}`,
            `${path}.id`,
          );
        }
        const storage = parseAssetStorage(asset.storage, `${path}.storage`);
        const mimeType = parseAssetMimeType(asset.mimeType, `${path}.mimeType`);
        const common = {
          id,
          mimeType,
          created: expectFiniteNumber(asset.created, `${path}.created`),
          ...(asset.lastRetrieved === undefined
            ? {}
            : {
                lastRetrieved: expectFiniteNumber(
                  asset.lastRetrieved,
                  `${path}.lastRetrieved`,
                ),
              }),
          ...(asset.byteSize === undefined
            ? {}
            : {
                byteSize: expectNonNegativeNumber(
                  asset.byteSize,
                  `${path}.byteSize`,
                ),
              }),
          ...(asset.contentHash === undefined
            ? {}
            : {
                contentHash: expectNonEmptyString(
                  asset.contentHash,
                  `${path}.contentHash`,
                ),
              }),
          ...(asset.width === undefined
            ? {}
            : {
                width: expectPositiveNumber(asset.width, `${path}.width`),
              }),
          ...(asset.height === undefined
            ? {}
            : {
                height: expectPositiveNumber(asset.height, `${path}.height`),
              }),
        };
        if (storage === "external") {
          if (asset.dataURL !== undefined) {
            throw new WhiteboardDocumentError(
              "UNSUPPORTED_FIELD",
              "External assets cannot embed dataURL",
              `${path}.dataURL`,
            );
          }
          return [
            key,
            { ...common, storage } satisfies WhiteboardAssetV2,
          ] as const;
        }
        if (mimeType === "application/octet-stream") {
          throw new WhiteboardDocumentError(
            "UNSUPPORTED_FIELD",
            "Inline assets must use a supported image MIME type",
            `${path}.mimeType`,
          );
        }
        const dataURL = expectString(asset.dataURL, `${path}.dataURL`);
        validateAssetDataURL(dataURL, mimeType, path);
        return [
          key,
          { ...common, storage, dataURL } satisfies WhiteboardAssetV2,
        ] as const;
      }),
  );
}

function parseMetadata(value: unknown): WhiteboardDocumentMetadataV2 {
  const object = expectObject(value, "$.metadata");
  assertOnlyFields(object, METADATA_FIELDS, "$.metadata");
  return {
    name: expectString(object.name, "$.metadata.name"),
    theme: parseTheme(object.theme, "$.metadata.theme"),
    viewBackgroundColor: expectString(
      object.viewBackgroundColor,
      "$.metadata.viewBackgroundColor",
    ),
    gridSize:
      object.gridSize === null
        ? null
        : expectFiniteNumber(object.gridSize, "$.metadata.gridSize"),
  };
}

function normalizeRuntimeElement(
  element: WhiteboardElement,
  index: number,
): WhiteboardElementV2 {
  const source = element as unknown as JsonObject;
  const path = `$.elements[${index}]`;
  assertOnlyFields(source, ELEMENT_FIELDS, path);
  const type = parseElementType(element.type, `${path}.type`);
  assertElementVariantFields(source, type, path);
  const width = finiteOr(element.width, 0);
  const height = finiteOr(element.height, 0);
  const compatibilityFields = Object.fromEntries(
    Object.entries(source)
      .filter(
        ([key, value]) =>
          ELEMENT_FIELDS.has(key) &&
          !CORE_ELEMENT_FIELDS.has(key) &&
          value !== undefined,
      )
      .map(([key, value]) => {
        assertJsonValue(value, `${path}.${escapePathSegment(key)}`);
        return [key, cloneJson(value)] as const;
      }),
  );
  const base = {
    ...compatibilityFields,
    id: expectNonEmptyString(element.id, `${path}.id`),
    type,
    isDeleted: element.isDeleted,
    x: finiteOr(element.x, 0),
    y: finiteOr(element.y, 0),
    width,
    height,
    angle: finiteOr(element.angle, 0),
    strokeColor: stringOr(element.strokeColor, "#1b1b1f"),
    backgroundColor: stringOr(element.backgroundColor, "transparent"),
    fillStyle: normalizeFillStyle(element.fillStyle),
    strokeWidth: nonNegativeOr(element.strokeWidth, 1),
    strokeStyle: normalizeStrokeStyle(element.strokeStyle),
    opacity: rangeOr(element.opacity, 0, 100, 100),
    roughness: nonNegativeOr(element.roughness, 1),
    locked: element.locked === true,
  };
  if (LINEAR_ELEMENT_TYPES.has(type)) {
    const points = normalizePoints(element.points);
    return {
      ...base,
      type,
      points:
        points.length > 0
          ? points
          : [
              [0, 0],
              [width, height],
            ],
    } as WhiteboardElementV2;
  }
  if (type === "image") {
    return {
      ...base,
      type,
      fileId:
        typeof element.fileId === "string" && element.fileId.length > 0
          ? element.fileId
          : null,
    };
  }
  if (type === "text") {
    const text = stringOr(element.text, "");
    return {
      ...base,
      type,
      text,
      originalText: stringOr(element.originalText, text),
      fontSize: positiveOr(element.fontSize, 20),
      lineHeight: positiveOr(element.lineHeight, 1.25),
    };
  }
  return base as WhiteboardElementV2;
}

function assertElementVariantFields(
  object: JsonObject,
  type: WhiteboardElementType,
  path: string,
): void {
  const variantFields = [
    ["fileId", type === "image"],
    ["fontSize", type === "text"],
    ["lineHeight", type === "text"],
    ["originalText", type === "text"],
    ["points", LINEAR_ELEMENT_TYPES.has(type)],
    ["text", type === "text"],
  ] as const;
  for (const [field, supported] of variantFields) {
    if (!supported && object[field] !== undefined) {
      throw new WhiteboardDocumentError(
        "UNSUPPORTED_FIELD",
        `Element type ${type} does not support ${field}`,
        `${path}.${field}`,
      );
    }
  }
}

function createPersistedAsset(
  asset: WhiteboardAsset,
  storage: "external" | "inline",
): WhiteboardAssetV2 {
  const common = {
    id: expectNonEmptyString(asset.id, "$.assets[].id"),
    mimeType: parseAssetMimeType(asset.mimeType, "$.assets[].mimeType"),
    created: expectFiniteNumber(asset.created, "$.assets[].created"),
    ...(asset.lastRetrieved === undefined
      ? {}
      : {
          lastRetrieved: expectFiniteNumber(
            asset.lastRetrieved,
            "$.assets[].lastRetrieved",
          ),
        }),
    ...(asset.byteSize === undefined
      ? {}
      : {
          byteSize: expectNonNegativeNumber(
            asset.byteSize,
            "$.assets[].byteSize",
          ),
        }),
    ...(asset.contentHash === undefined
      ? {}
      : {
          contentHash: expectNonEmptyString(
            asset.contentHash,
            "$.assets[].contentHash",
          ),
        }),
    ...(asset.width === undefined
      ? {}
      : { width: expectPositiveNumber(asset.width, "$.assets[].width") }),
    ...(asset.height === undefined
      ? {}
      : { height: expectPositiveNumber(asset.height, "$.assets[].height") }),
  };
  if (storage === "external") return { ...common, storage };
  validateAssetDataURL(asset.dataURL, common.mimeType, "$.assets[]");
  return { ...common, storage, dataURL: asset.dataURL };
}

function metadataFromRuntime(
  document: WhiteboardDocument,
): WhiteboardDocumentMetadataV2 {
  return {
    name: typeof document.state.name === "string" ? document.state.name : "",
    theme: document.state.theme === "dark" ? "dark" : "light",
    viewBackgroundColor:
      typeof document.state.viewBackgroundColor === "string"
        ? document.state.viewBackgroundColor
        : "#ffffff",
    gridSize:
      typeof document.state.gridSize === "number" &&
      Number.isFinite(document.state.gridSize)
        ? document.state.gridSize
        : null,
  };
}

function assertReferencedAssetsExist(
  elements: readonly WhiteboardElementV2[],
  assets: Readonly<Record<string, WhiteboardAssetV2>>,
): void {
  elements.forEach((element, index) => {
    if (
      !element.isDeleted &&
      element.type === "image" &&
      element.fileId !== null &&
      !assets[element.fileId]
    ) {
      throw new WhiteboardDocumentError(
        "MISSING_ASSET",
        `Image element ${element.id} references missing asset ${element.fileId}`,
        `$.elements[${index}].fileId`,
      );
    }
  });
}

function validateAssetDataURL(
  dataURL: string,
  mimeType: WhiteboardAssetMimeTypeV2,
  path: string,
): void {
  const separator = dataURL.search(/[;,]/);
  const sourceMimeType =
    dataURL.startsWith("data:") && separator > 5
      ? dataURL.slice(5, separator).toLowerCase()
      : "";
  if (
    mimeType === "application/octet-stream" &&
    ASSET_MIME_TYPES.has(sourceMimeType as WhiteboardAssetMimeTypeV2) &&
    sourceMimeType !== "application/octet-stream"
  ) {
    return;
  }
  if (sourceMimeType !== mimeType) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Inline asset dataURL must match mimeType",
      `${path}.dataURL`,
    );
  }
}

function assertOnlyFields(
  object: JsonObject,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unsupported = Object.keys(object).find((key) => !allowed.has(key));
  if (unsupported) {
    throw new WhiteboardDocumentError(
      "UNSUPPORTED_FIELD",
      `Unsupported field ${unsupported}`,
      `${path}.${escapePathSegment(unsupported)}`,
    );
  }
}

function parseElementType(value: unknown, path: string): WhiteboardElementType {
  if (
    typeof value !== "string" ||
    !ELEMENT_TYPES.has(value as WhiteboardElementType)
  ) {
    throw new WhiteboardDocumentError(
      "UNSUPPORTED_ELEMENT",
      `Unsupported element type ${describeUnknown(value)}`,
      path,
    );
  }
  return value as WhiteboardElementType;
}

function isLinearElementType(
  type: WhiteboardElementType,
): type is "arrow" | "freedraw" | "line" {
  return LINEAR_ELEMENT_TYPES.has(type);
}

function parseAssetMimeType(
  value: unknown,
  path: string,
): WhiteboardAssetMimeTypeV2 {
  if (
    typeof value !== "string" ||
    !ASSET_MIME_TYPES.has(value.toLowerCase() as WhiteboardAssetMimeTypeV2)
  ) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      `Unsupported asset MIME type ${describeUnknown(value)}`,
      path,
    );
  }
  return value.toLowerCase() as WhiteboardAssetMimeTypeV2;
}

function parseAssetStorage(
  value: unknown,
  path: string,
): "external" | "inline" {
  if (value !== "external" && value !== "inline") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected asset storage to be external or inline",
      path,
    );
  }
  return value;
}

function parseFillStyle(value: unknown, path: string): WhiteboardFillStyle {
  if (
    value !== "hachure" &&
    value !== "cross-hatch" &&
    value !== "solid" &&
    value !== "zigzag"
  ) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Unsupported fill style",
      path,
    );
  }
  return value;
}

function parseStrokeStyle(value: unknown, path: string): WhiteboardStrokeStyle {
  if (value !== "solid" && value !== "dashed" && value !== "dotted") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Unsupported stroke style",
      path,
    );
  }
  return value;
}

function parseTheme(value: unknown, path: string): WhiteboardTheme {
  if (value !== "light" && value !== "dark") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected theme to be light or dark",
      path,
    );
  }
  return value;
}

function parsePoints(
  value: unknown,
  path: string,
): readonly (readonly [number, number])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a non-empty points array",
      path,
    );
  }
  return value.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new WhiteboardDocumentError(
        "MALFORMED_DOCUMENT",
        "Expected a two-number point",
        `${path}[${index}]`,
      );
    }
    return [
      expectFiniteNumber(point[0], `${path}[${index}][0]`),
      expectFiniteNumber(point[1], `${path}[${index}][1]`),
    ] as const;
  });
}

function normalizePoints(
  value: WhiteboardElement["points"],
): readonly (readonly [number, number])[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) =>
    Array.isArray(point) &&
    typeof point[0] === "number" &&
    Number.isFinite(point[0]) &&
    typeof point[1] === "number" &&
    Number.isFinite(point[1])
      ? [[point[0], point[1]] as const]
      : [],
  );
}

function parseJsonInput(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new WhiteboardDocumentError(
      "INVALID_JSON",
      "Document is not valid JSON",
    );
  }
}

function expectObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected an object",
      path,
    );
  }
  return value as JsonObject;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a string",
      path,
    );
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const string = expectString(value, path);
  if (string.length === 0) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a non-empty string",
      path,
    );
  }
  return string;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a boolean",
      path,
    );
  }
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a finite number",
      path,
    );
  }
  return value;
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (number < 0) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a non-negative number",
      path,
    );
  }
  return number;
}

function expectPositiveNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (number <= 0) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected a positive number",
      path,
    );
  }
  return number;
}

function expectRange(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): number {
  const number = expectFiniteNumber(value, path);
  if (number < minimum || number > maximum) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      `Expected a number from ${minimum} to ${maximum}`,
      path,
    );
  }
  return number;
}

function assertJsonValue(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        assertJsonValue(item, `${path}.${escapePathSegment(key)}`);
      }
    }
    return;
  }
  throw new WhiteboardDocumentError(
    "MALFORMED_DOCUMENT",
    "Expected JSON-compatible data",
    path,
  );
}

function stableStringify(value: unknown): string {
  assertJsonValue(value, "$");
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  const object = value as JsonObject;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, sortJsonValue(object[key])]),
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function rangeOr(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function stringOr(value: string | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeFillStyle(
  value: WhiteboardFillStyle | undefined,
): WhiteboardFillStyle {
  return value === "cross-hatch" ||
    value === "hachure" ||
    value === "solid" ||
    value === "zigzag"
    ? value
    : "solid";
}

function normalizeStrokeStyle(
  value: WhiteboardStrokeStyle | undefined,
): WhiteboardStrokeStyle {
  return value === "dashed" || value === "dotted" || value === "solid"
    ? value
    : "solid";
}

function escapePathSegment(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
}

function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function describeUnknown(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return typeof value;
}
