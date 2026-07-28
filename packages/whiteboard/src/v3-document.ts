import type {
  OwnedWhiteboardDocument,
  WhiteboardAsset,
  WhiteboardAssetMimeTypeV2,
  WhiteboardAssetV3,
  WhiteboardBindingV3,
  WhiteboardDocumentMetadataV3,
  WhiteboardDocumentV3,
  WhiteboardElement,
  WhiteboardElementType,
  WhiteboardElementV3,
  WhiteboardFillStyle,
  WhiteboardImageCropV3,
  WhiteboardStrokeStyle,
  WhiteboardTheme,
} from "./contracts";
import { WhiteboardDocumentError } from "./document-errors";

export const WHITEBOARD_DOCUMENT_VERSION = 3 as const;

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
const FILL_STYLES = new Set<WhiteboardFillStyle>([
  "hachure",
  "cross-hatch",
  "solid",
  "zigzag",
]);
const STROKE_STYLES = new Set<WhiteboardStrokeStyle>([
  "solid",
  "dashed",
  "dotted",
]);
const MIME_TYPES = new Set<WhiteboardAssetMimeTypeV2>([
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

type JsonObject = Record<string, unknown>;

export function parseWhiteboardDocumentV3(
  payload: unknown,
): WhiteboardDocumentV3 {
  const root = object(parseJsonInput(payload), "$");
  only(root, ["assets", "elements", "metadata", "version"], "$");
  if (root.version !== WHITEBOARD_DOCUMENT_VERSION) {
    throw documentError(
      typeof root.version === "number"
        ? "UNSUPPORTED_VERSION"
        : "MALFORMED_DOCUMENT",
      `Expected whiteboard document version ${WHITEBOARD_DOCUMENT_VERSION}`,
      "$.version",
    );
  }
  if (!Array.isArray(root.elements)) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Expected an elements array",
      "$.elements",
    );
  }
  const ids = new Set<string>();
  const indexes = new Set<string>();
  const elements = root.elements.map((value, index) => {
    const element = parseElement(value, `$.elements[${index}]`);
    if (ids.has(element.id)) {
      throw documentError(
        "MALFORMED_DOCUMENT",
        `Duplicate element id ${element.id}`,
        `$.elements[${index}].id`,
      );
    }
    ids.add(element.id);
    if (indexes.has(element.index)) {
      throw documentError(
        "MALFORMED_DOCUMENT",
        `Duplicate element index ${element.index}`,
        `$.elements[${index}].index`,
      );
    }
    indexes.add(element.index);
    return element;
  });
  const assets = parseAssets(root.assets);
  const metadata = parseMetadata(root.metadata);
  for (const element of elements) {
    if (
      !element.isDeleted &&
      element.type === "image" &&
      element.fileId !== null &&
      !assets[element.fileId]
    ) {
      throw documentError(
        "MISSING_ASSET",
        `Image element references missing asset ${element.fileId}`,
        "$.assets",
      );
    }
    if (
      element.type === "text" &&
      element.containerId !== null &&
      !ids.has(element.containerId)
    ) {
      throw documentError(
        "MALFORMED_DOCUMENT",
        `Text references missing container ${element.containerId}`,
        "$.elements",
      );
    }
    if (element.type === "arrow" || element.type === "line") {
      validateBinding(element.startBinding, ids, element.id);
      validateBinding(element.endBinding, ids, element.id);
    }
  }
  return {
    version: WHITEBOARD_DOCUMENT_VERSION,
    elements: elements.sort((a, b) =>
      a.index < b.index ? -1 : a.index > b.index ? 1 : 0,
    ),
    assets,
    metadata,
  };
}

export function createWhiteboardDocumentV3(
  input: Omit<WhiteboardDocumentV3, "version">,
): WhiteboardDocumentV3 {
  return parseWhiteboardDocumentV3({
    version: WHITEBOARD_DOCUMENT_VERSION,
    ...input,
  });
}

export function serializeWhiteboardDocumentV3(
  document: WhiteboardDocumentV3,
): string {
  return stableStringify(parseWhiteboardDocumentV3(document));
}

export function createPersistedWhiteboardDocumentV3(
  document: OwnedWhiteboardDocument,
  options?: {
    readonly assetStorage?: "external" | "inline";
    readonly now?: number;
  },
): WhiteboardDocumentV3 {
  const now = options?.now ?? Date.now();
  const elements = document.elements.map((element, position) =>
    normalizeRuntimeElement(element, position, now),
  );
  const referencedAssets = new Set(
    elements.flatMap((element) =>
      !element.isDeleted && element.type === "image" && element.fileId
        ? [element.fileId]
        : [],
    ),
  );
  const storage = options?.assetStorage ?? "inline";
  const assets = Object.fromEntries(
    [...referencedAssets].sort().map((id) => {
      const asset = document.assets[id];
      if (!asset) {
        throw documentError(
          "MISSING_ASSET",
          `Image element references missing asset ${id}`,
          "$.assets",
        );
      }
      return [id, persistAsset(asset, storage)] as const;
    }),
  );
  return createWhiteboardDocumentV3({
    elements,
    assets,
    metadata: {
      name: document.state.name ?? "Untitled",
      theme: document.state.theme ?? "light",
      viewBackgroundColor: document.state.viewBackgroundColor ?? "#ffffff",
      gridSize: document.state.gridSize ?? null,
    },
  });
}

export function externalizeWhiteboardDocumentAssetsV3(
  document: WhiteboardDocumentV3,
): WhiteboardDocumentV3 {
  const parsed = parseWhiteboardDocumentV3(document);
  return createWhiteboardDocumentV3({
    ...parsed,
    assets: Object.fromEntries(
      Object.entries(parsed.assets).map(([id, asset]) => [
        id,
        { ...asset, storage: "external" as const, dataURL: undefined },
      ]),
    ),
  });
}

export function toRuntimeWhiteboardDocumentV3(
  document: WhiteboardDocumentV3,
): OwnedWhiteboardDocument {
  const parsed = parseWhiteboardDocumentV3(document);
  return {
    elements: parsed.elements,
    assets: Object.fromEntries(
      Object.entries(parsed.assets).flatMap(([id, asset]) =>
        asset.storage === "inline" && asset.dataURL
          ? [
              [
                id,
                {
                  id,
                  dataURL: asset.dataURL,
                  mimeType: asset.mimeType,
                  created: asset.created,
                  revision: asset.revision,
                  lastRetrieved: asset.lastRetrieved,
                  byteSize: asset.byteSize,
                  contentHash: asset.contentHash,
                  width: asset.width,
                  height: asset.height,
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

function parseElement(value: unknown, path: string): WhiteboardElementV3 {
  const source = object(value, path);
  const type = enumValue(source.type, ELEMENT_TYPES, `${path}.type`);
  const commonFields = [
    "angle",
    "backgroundColor",
    "fillStyle",
    "frameId",
    "groupIds",
    "height",
    "id",
    "index",
    "isDeleted",
    "locked",
    "opacity",
    "roughness",
    "roundness",
    "seed",
    "strokeColor",
    "strokeStyle",
    "strokeWidth",
    "type",
    "updatedAt",
    "version",
    "versionNonce",
    "width",
    "x",
    "y",
  ];
  const variantFields =
    type === "text"
      ? [
          "autoResize",
          "containerId",
          "fontFamily",
          "fontSize",
          "lineHeight",
          "originalText",
          "text",
          "textAlign",
          "verticalAlign",
        ]
      : type === "arrow" || type === "line"
        ? [
            "elbowed",
            "endArrowhead",
            "endBinding",
            "fixedSegments",
            "points",
            "startArrowhead",
            "startBinding",
          ]
        : type === "freedraw"
          ? ["lastCommittedPoint", "points", "pressures", "simulatePressure"]
          : type === "image"
            ? ["crop", "fileId", "scale", "status"]
            : type === "frame"
              ? ["name"]
              : [];
  only(source, [...commonFields, ...variantFields], path);
  const base = {
    id: nonEmptyString(source.id, `${path}.id`),
    type,
    index: nonEmptyString(source.index, `${path}.index`),
    isDeleted: booleanValue(source.isDeleted, `${path}.isDeleted`),
    x: numberValue(source.x, `${path}.x`),
    y: numberValue(source.y, `${path}.y`),
    width: nonNegative(source.width, `${path}.width`),
    height: nonNegative(source.height, `${path}.height`),
    angle: numberValue(source.angle, `${path}.angle`),
    strokeColor: stringValue(source.strokeColor, `${path}.strokeColor`),
    backgroundColor: stringValue(
      source.backgroundColor,
      `${path}.backgroundColor`,
    ),
    fillStyle: enumValue(source.fillStyle, FILL_STYLES, `${path}.fillStyle`),
    strokeWidth: nonNegative(source.strokeWidth, `${path}.strokeWidth`),
    strokeStyle: enumValue(
      source.strokeStyle,
      STROKE_STYLES,
      `${path}.strokeStyle`,
    ),
    opacity: range(source.opacity, 0, 100, `${path}.opacity`),
    roughness: nonNegative(source.roughness, `${path}.roughness`),
    ...(source.roundness === undefined
      ? {}
      : {
          roundness: enumValue(
            source.roundness,
            new Set(["sharp", "round"] as const),
            `${path}.roundness`,
          ),
        }),
    seed: integer(source.seed, `${path}.seed`),
    version: positiveInteger(source.version, `${path}.version`),
    versionNonce: integer(source.versionNonce, `${path}.versionNonce`),
    updatedAt: nonNegative(source.updatedAt, `${path}.updatedAt`),
    groupIds: stringArray(source.groupIds, `${path}.groupIds`),
    frameId: nullableString(source.frameId, `${path}.frameId`),
    locked: booleanValue(source.locked, `${path}.locked`),
  } as const;
  if (type === "text") {
    return {
      ...base,
      type,
      text: stringValue(source.text, `${path}.text`),
      originalText: stringValue(source.originalText, `${path}.originalText`),
      fontFamily: enumValue(
        source.fontFamily,
        new Set(["excalifont", "nunito", "system"] as const),
        `${path}.fontFamily`,
      ),
      fontSize: positive(source.fontSize, `${path}.fontSize`),
      lineHeight: positive(source.lineHeight, `${path}.lineHeight`),
      textAlign: enumValue(
        source.textAlign,
        new Set(["left", "center", "right"] as const),
        `${path}.textAlign`,
      ),
      verticalAlign: enumValue(
        source.verticalAlign,
        new Set(["top", "middle", "bottom"] as const),
        `${path}.verticalAlign`,
      ),
      containerId: nullableString(source.containerId, `${path}.containerId`),
      autoResize: booleanValue(source.autoResize, `${path}.autoResize`),
    };
  }
  if (type === "arrow" || type === "line") {
    return {
      ...base,
      type,
      points: points(source.points, `${path}.points`),
      startArrowhead: nullableString(
        source.startArrowhead,
        `${path}.startArrowhead`,
      ),
      endArrowhead: nullableString(source.endArrowhead, `${path}.endArrowhead`),
      startBinding: binding(source.startBinding, `${path}.startBinding`),
      endBinding: binding(source.endBinding, `${path}.endBinding`),
      elbowed: booleanValue(source.elbowed, `${path}.elbowed`),
      fixedSegments: numberArray(source.fixedSegments, `${path}.fixedSegments`),
    };
  }
  if (type === "freedraw") {
    const parsedPoints = points(source.points, `${path}.points`);
    const pressures = numberArray(source.pressures, `${path}.pressures`);
    if (pressures.length !== 0 && pressures.length !== parsedPoints.length) {
      throw documentError(
        "MALFORMED_DOCUMENT",
        "Freedraw pressures must be empty or match points",
        `${path}.pressures`,
      );
    }
    return {
      ...base,
      type,
      points: parsedPoints,
      pressures,
      simulatePressure: booleanValue(
        source.simulatePressure,
        `${path}.simulatePressure`,
      ),
      lastCommittedPoint:
        source.lastCommittedPoint === null
          ? null
          : point(source.lastCommittedPoint, `${path}.lastCommittedPoint`),
    };
  }
  if (type === "image") {
    return {
      ...base,
      type,
      fileId: nullableString(source.fileId, `${path}.fileId`),
      status: enumValue(
        source.status,
        new Set(["pending", "saved", "error"] as const),
        `${path}.status`,
      ),
      scale: point(source.scale, `${path}.scale`),
      crop: crop(source.crop, `${path}.crop`),
    };
  }
  if (type === "frame") {
    return {
      ...base,
      type,
      name: stringValue(source.name, `${path}.name`),
    };
  }
  return { ...base, type };
}

function normalizeRuntimeElement(
  element: WhiteboardElement,
  position: number,
  now: number,
): WhiteboardElementV3 {
  const source = element as WhiteboardElement & Record<string, unknown>;
  const base = {
    id: element.id,
    type: element.type,
    index:
      typeof source.index === "string"
        ? source.index
        : `a${position.toString(36).padStart(10, "0")}`,
    isDeleted: element.isDeleted,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    opacity: element.opacity,
    roughness: element.roughness,
    ...(element.roundness ? { roundness: element.roundness } : {}),
    seed: finiteInteger(source.seed, hashString(element.id)),
    version: Math.max(1, finiteInteger(source.version, 1)),
    versionNonce: finiteInteger(source.versionNonce, hashString(element.id)),
    updatedAt: finiteNumber(source.updatedAt, now),
    groupIds: Array.isArray(source.groupIds)
      ? source.groupIds.filter((id): id is string => typeof id === "string")
      : [],
    frameId: typeof source.frameId === "string" ? source.frameId : null,
    locked: element.locked,
  } as const;
  if (element.type === "text") {
    return {
      ...base,
      type: "text",
      text: element.text,
      originalText: element.originalText,
      fontFamily:
        source.fontFamily === "nunito" || source.fontFamily === "system"
          ? source.fontFamily
          : "excalifont",
      fontSize: element.fontSize,
      lineHeight: element.lineHeight,
      textAlign:
        source.textAlign === "center" || source.textAlign === "right"
          ? source.textAlign
          : "left",
      verticalAlign:
        source.verticalAlign === "middle" || source.verticalAlign === "bottom"
          ? source.verticalAlign
          : "top",
      containerId:
        typeof source.containerId === "string" ? source.containerId : null,
      autoResize: source.autoResize !== false,
    };
  }
  if (element.type === "arrow" || element.type === "line") {
    return {
      ...base,
      type: element.type,
      points: element.points,
      startArrowhead:
        typeof source.startArrowhead === "string"
          ? source.startArrowhead
          : null,
      endArrowhead:
        typeof source.endArrowhead === "string" ? source.endArrowhead : null,
      startBinding: normalizeBinding(source.startBinding),
      endBinding: normalizeBinding(source.endBinding),
      elbowed: source.elbowed === true,
      fixedSegments: Array.isArray(source.fixedSegments)
        ? source.fixedSegments.filter(
            (segment): segment is number =>
              typeof segment === "number" && Number.isFinite(segment),
          )
        : [],
    };
  }
  if (element.type === "freedraw") {
    const pressures = Array.isArray(source.pressures)
      ? source.pressures.filter(
          (pressure): pressure is number =>
            typeof pressure === "number" && Number.isFinite(pressure),
        )
      : [];
    return {
      ...base,
      type: "freedraw",
      points: element.points,
      pressures: pressures.length === element.points.length ? pressures : [],
      simulatePressure: source.simulatePressure !== false,
      lastCommittedPoint:
        Array.isArray(source.lastCommittedPoint) &&
        source.lastCommittedPoint.length === 2 &&
        source.lastCommittedPoint.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
          ? (source.lastCommittedPoint as unknown as readonly [number, number])
          : (element.points.at(-1) ?? null),
    };
  }
  if (element.type === "image") {
    return {
      ...base,
      type: "image",
      fileId: element.fileId,
      status:
        source.status === "pending" || source.status === "error"
          ? source.status
          : "saved",
      scale:
        Array.isArray(source.scale) &&
        source.scale.length === 2 &&
        source.scale.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
          ? (source.scale as unknown as readonly [number, number])
          : [1, 1],
      crop: normalizeCrop(source.crop),
    };
  }
  if (element.type === "frame") {
    return {
      ...base,
      type: "frame",
      name: typeof source.name === "string" ? source.name : "",
    };
  }
  return { ...base, type: element.type };
}

function parseAssets(
  value: unknown,
): Readonly<Record<string, WhiteboardAssetV3>> {
  const source = object(value, "$.assets");
  const entries = Object.entries(source)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const path = `$.assets.${id}`;
      const asset = object(value, path);
      only(
        asset,
        [
          "byteSize",
          "contentHash",
          "created",
          "dataURL",
          "height",
          "id",
          "lastRetrieved",
          "mimeType",
          "revision",
          "storage",
          "width",
        ],
        path,
      );
      if (asset.id !== id) {
        throw documentError(
          "MALFORMED_DOCUMENT",
          "Asset key must match asset id",
          `${path}.id`,
        );
      }
      const storage = enumValue(
        asset.storage,
        new Set(["external", "inline"] as const),
        `${path}.storage`,
      );
      const dataURL =
        asset.dataURL === undefined
          ? undefined
          : stringValue(asset.dataURL, `${path}.dataURL`);
      if (storage === "inline" && !dataURL) {
        throw documentError(
          "MALFORMED_DOCUMENT",
          "Inline assets require dataURL",
          `${path}.dataURL`,
        );
      }
      return [
        id,
        {
          id,
          mimeType: enumValue(asset.mimeType, MIME_TYPES, `${path}.mimeType`),
          created: nonNegative(asset.created, `${path}.created`),
          revision: nonNegative(asset.revision, `${path}.revision`),
          storage,
          ...(dataURL === undefined ? {} : { dataURL }),
          ...optionalNumberFields(asset, path, [
            "lastRetrieved",
            "byteSize",
            "width",
            "height",
          ]),
          ...(asset.contentHash === undefined
            ? {}
            : {
                contentHash: stringValue(
                  asset.contentHash,
                  `${path}.contentHash`,
                ),
              }),
        } satisfies WhiteboardAssetV3,
      ] as const;
    });
  return Object.fromEntries(entries);
}

function parseMetadata(value: unknown): WhiteboardDocumentMetadataV3 {
  const source = object(value, "$.metadata");
  only(
    source,
    ["gridSize", "name", "theme", "viewBackgroundColor"],
    "$.metadata",
  );
  return {
    name: stringValue(source.name, "$.metadata.name"),
    theme: enumValue(
      source.theme,
      new Set<WhiteboardTheme>(["light", "dark"]),
      "$.metadata.theme",
    ),
    viewBackgroundColor: stringValue(
      source.viewBackgroundColor,
      "$.metadata.viewBackgroundColor",
    ),
    gridSize:
      source.gridSize === null
        ? null
        : positive(source.gridSize, "$.metadata.gridSize"),
  };
}

function persistAsset(
  asset: WhiteboardAsset,
  storage: "external" | "inline",
): WhiteboardAssetV3 {
  const mimeType = MIME_TYPES.has(asset.mimeType as WhiteboardAssetMimeTypeV2)
    ? (asset.mimeType as WhiteboardAssetMimeTypeV2)
    : "application/octet-stream";
  return {
    id: asset.id,
    mimeType,
    created: asset.created,
    revision: asset.revision ?? 1,
    storage,
    ...(storage === "inline" ? { dataURL: asset.dataURL } : {}),
    ...(asset.lastRetrieved === undefined
      ? {}
      : { lastRetrieved: asset.lastRetrieved }),
    ...(asset.byteSize === undefined ? {} : { byteSize: asset.byteSize }),
    ...(asset.contentHash === undefined
      ? {}
      : { contentHash: asset.contentHash }),
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
  };
}

function binding(value: unknown, path: string): WhiteboardBindingV3 | null {
  if (value === null) return null;
  const source = object(value, path);
  only(source, ["elementId", "fixedPoint", "focus", "gap"], path);
  return {
    elementId: nonEmptyString(source.elementId, `${path}.elementId`),
    focus: range(source.focus, -1, 1, `${path}.focus`),
    gap: nonNegative(source.gap, `${path}.gap`),
    ...(source.fixedPoint === undefined
      ? {}
      : { fixedPoint: point(source.fixedPoint, `${path}.fixedPoint`) }),
  };
}

function validateBinding(
  value: WhiteboardBindingV3 | null,
  ids: ReadonlySet<string>,
  ownerId: string,
): void {
  if (!value) return;
  if (value.elementId === ownerId || !ids.has(value.elementId)) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      `Invalid binding target ${value.elementId}`,
      "$.elements",
    );
  }
}

function normalizeBinding(value: unknown): WhiteboardBindingV3 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.elementId !== "string" ||
    typeof source.focus !== "number" ||
    !Number.isFinite(source.focus) ||
    typeof source.gap !== "number" ||
    !Number.isFinite(source.gap)
  ) {
    return null;
  }
  return {
    elementId: source.elementId,
    focus: Math.max(-1, Math.min(1, source.focus)),
    gap: Math.max(0, source.gap),
  };
}

function crop(value: unknown, path: string): WhiteboardImageCropV3 | null {
  if (value === null) return null;
  const source = object(value, path);
  only(
    source,
    ["height", "naturalHeight", "naturalWidth", "width", "x", "y"],
    path,
  );
  return {
    x: nonNegative(source.x, `${path}.x`),
    y: nonNegative(source.y, `${path}.y`),
    width: positive(source.width, `${path}.width`),
    height: positive(source.height, `${path}.height`),
    naturalWidth: positive(source.naturalWidth, `${path}.naturalWidth`),
    naturalHeight: positive(source.naturalHeight, `${path}.naturalHeight`),
  };
}

function normalizeCrop(value: unknown): WhiteboardImageCropV3 | null {
  try {
    return crop(value ?? null, "$.crop");
  } catch {
    return null;
  }
}

function parseJsonInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Document is not valid JSON",
      "$",
    );
  }
}

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw documentError("MALFORMED_DOCUMENT", "Expected an object", path);
  }
  return value as JsonObject;
}

function only(
  source: JsonObject,
  fields: readonly string[],
  path: string,
): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw documentError(
        "MALFORMED_DOCUMENT",
        `Unknown field ${key}`,
        `${path}.${key}`,
      );
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw documentError("MALFORMED_DOCUMENT", "Expected a string", path);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (result.length === 0) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Expected a non-empty string",
      path,
    );
  }
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringValue(value, path);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw documentError("MALFORMED_DOCUMENT", "Expected a boolean", path);
  }
  return value;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw documentError("MALFORMED_DOCUMENT", "Expected a finite number", path);
  }
  return value;
}

function nonNegative(value: unknown, path: string): number {
  const result = numberValue(value, path);
  if (result < 0) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Expected a non-negative number",
      path,
    );
  }
  return result;
}

function positive(value: unknown, path: string): number {
  const result = numberValue(value, path);
  if (result <= 0) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Expected a positive number",
      path,
    );
  }
  return result;
}

function integer(value: unknown, path: string): number {
  const result = numberValue(value, path);
  if (!Number.isInteger(result)) {
    throw documentError("MALFORMED_DOCUMENT", "Expected an integer", path);
  }
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  const result = integer(value, path);
  if (result < 1) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Expected a positive integer",
      path,
    );
  }
  return result;
}

function range(value: unknown, min: number, max: number, path: string): number {
  const result = numberValue(value, path);
  if (result < min || result > max) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      `Expected a number between ${min} and ${max}`,
      path,
    );
  }
  return result;
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  path: string,
): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw documentError("MALFORMED_DOCUMENT", "Unexpected enum value", path);
  }
  return value as T;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw documentError("MALFORMED_DOCUMENT", "Expected an array", path);
  }
  const result = value.map((entry, index) =>
    nonEmptyString(entry, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw documentError("MALFORMED_DOCUMENT", "Expected unique values", path);
  }
  return result;
}

function numberArray(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value)) {
    throw documentError("MALFORMED_DOCUMENT", "Expected an array", path);
  }
  return value.map((entry, index) => numberValue(entry, `${path}[${index}]`));
}

function point(value: unknown, path: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw documentError("MALFORMED_DOCUMENT", "Expected a point", path);
  }
  return [
    numberValue(value[0], `${path}[0]`),
    numberValue(value[1], `${path}[1]`),
  ];
}

function points(
  value: unknown,
  path: string,
): readonly (readonly [number, number])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw documentError(
      "MALFORMED_DOCUMENT",
      "Expected a non-empty points array",
      path,
    );
  }
  return value.map((entry, index) => point(entry, `${path}[${index}]`));
}

function optionalNumberFields(
  source: JsonObject,
  path: string,
  fields: readonly string[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    fields.flatMap((field) =>
      source[field] === undefined
        ? []
        : [[field, nonNegative(source[field], `${path}.${field}`)] as const],
    ),
  );
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
    ? value
    : fallback;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function documentError(
  code: ConstructorParameters<typeof WhiteboardDocumentError>[0],
  message: string,
  path: string,
): WhiteboardDocumentError {
  return new WhiteboardDocumentError(code, message, path);
}
