import type {
  WhiteboardAsset,
  WhiteboardAssetMimeTypeV2,
  WhiteboardAssetV2,
  OwnedWhiteboardDocument,
  WhiteboardDocumentMetadataV2,
  WhiteboardDocumentV2,
  WhiteboardElement,
  WhiteboardElementType,
  WhiteboardElementV2,
  WhiteboardEdgeStyle,
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

const ELEMENT_FIELDS = new Set([
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
  "roundness",
  "strokeColor",
  "strokeStyle",
  "strokeWidth",
  "text",
  "type",
  "width",
  "x",
  "y",
]);

// Earlier canonical V2 writers preserved these source-engine properties.
// Readers discard them immediately while continuing to reject every other key.
const EARLIER_V2_ELEMENT_FIELDS = new Set([
  ...ELEMENT_FIELDS,
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
  document: OwnedWhiteboardDocument,
  options?: {
    readonly assetStorage?: "external" | "inline";
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
): OwnedWhiteboardDocument {
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
    assertOnlyFields(object, EARLIER_V2_ELEMENT_FIELDS, path);
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
    const roundness = parseOptionalEdgeStyle(
      object.roundness,
      `${path}.roundness`,
    );
    const base = {
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
      ...(roundness ? { roundness } : {}),
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
  const path = `$.elements[${index}]`;
  const type = parseElementType(element.type, `${path}.type`);
  const width = element.width;
  const height = element.height;
  const base = {
    id: expectNonEmptyString(element.id, `${path}.id`),
    type,
    isDeleted: element.isDeleted,
    x: element.x,
    y: element.y,
    width,
    height,
    angle: element.angle,
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    opacity: element.opacity,
    roughness: element.roughness,
    ...(element.roundness ? { roundness: element.roundness } : {}),
    locked: element.locked,
  };
  if (isLinearElementType(type) && "points" in element) {
    return {
      ...base,
      type,
      points: element.points,
    };
  }
  if (type === "image" && "fileId" in element) {
    return {
      ...base,
      type,
      fileId: element.fileId,
    };
  }
  if (
    type === "text" &&
    "text" in element &&
    "originalText" in element &&
    "fontSize" in element &&
    "lineHeight" in element
  ) {
    return {
      ...base,
      type,
      text: element.text,
      originalText: element.originalText,
      fontSize: element.fontSize,
      lineHeight: element.lineHeight,
    };
  }
  if (
    type !== "arrow" &&
    type !== "freedraw" &&
    type !== "line" &&
    type !== "image" &&
    type !== "text"
  ) {
    return { ...base, type };
  }
  throw new WhiteboardDocumentError(
    "MALFORMED_DOCUMENT",
    `Element fields do not match type ${type}`,
    path,
  );
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
  document: OwnedWhiteboardDocument,
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

function parseOptionalEdgeStyle(
  value: unknown,
  path: string,
): WhiteboardEdgeStyle | undefined {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "object" && !Array.isArray(value))
  ) {
    return undefined;
  }
  if (value !== "sharp" && value !== "round") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Unsupported edge style",
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
