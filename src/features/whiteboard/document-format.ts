import type {
  WhiteboardAsset,
  WhiteboardDocument,
  WhiteboardDocumentMetadata,
  WhiteboardDocumentPersistence,
  WhiteboardDocumentState,
  WhiteboardDocumentV1,
  WhiteboardElement,
  WhiteboardJsonValue,
  WhiteboardTheme,
} from "./contracts";

export const WHITEBOARD_DOCUMENT_VERSION = 1 as const;
export const LEGACY_MIGRATION_VERSION = 1 as const;

const SUPPORTED_LEGACY_ELEMENT_TYPES = new Set([
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

const SUPPORTED_ASSET_MIME_TYPES = new Set([
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

const KNOWN_LEGACY_TOP_LEVEL_FIELDS = new Set([
  "appState",
  "elements",
  "files",
  "source",
  "type",
  "version",
]);

const KNOWN_LEGACY_APP_STATE_FIELDS = new Set([
  "gridSize",
  "name",
  "scrollX",
  "scrollY",
  "theme",
  "viewBackgroundColor",
  "zoom",
]);

const KNOWN_LEGACY_ELEMENT_FIELDS = new Set([
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
  "fillStyle",
  "fileId",
  "fontFamily",
  "fontSize",
  "frameId",
  "fixedSegments",
  "groupIds",
  "height",
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
  "width",
  "x",
  "y",
  "endIsSpecial",
]);

const KNOWN_LEGACY_ASSET_FIELDS = new Set([
  "byteSize",
  "contentHash",
  "created",
  "dataURL",
  "height",
  "id",
  "lastRetrieved",
  "mimeType",
  "width",
]);

type JsonObject = Readonly<Record<string, unknown>>;

export type PersistedWhiteboardPayload =
  | {
      readonly format: "whiteboard-v1";
      readonly document: WhiteboardDocumentV1;
    }
  | {
      readonly format: "legacy-excalidraw";
      readonly document: WhiteboardDocument;
      readonly originalPayload: string;
      readonly sourceVersion: number | null;
    };

export type WhiteboardDocumentErrorCode =
  | "INVALID_JSON"
  | "MALFORMED_DOCUMENT"
  | "MISSING_ASSET"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_VERSION";

export class WhiteboardDocumentError extends Error {
  public constructor(
    public readonly code: WhiteboardDocumentErrorCode,
    message: string,
    public readonly path = "$",
  ) {
    super(`${message} at ${path}`);
    this.name = "WhiteboardDocumentError";
  }
}

export function detectWhiteboardDocumentFormat(
  payload: unknown,
): PersistedWhiteboardPayload["format"] {
  const parsed = parseJsonInput(payload);
  const object = expectObject(parsed, "$");

  if (object.version === WHITEBOARD_DOCUMENT_VERSION) {
    if (
      Array.isArray(object.elements) &&
      isObject(object.assets) &&
      isObject(object.metadata)
    ) {
      return "whiteboard-v1";
    }
    if (object.type !== "excalidraw") {
      throw new WhiteboardDocumentError(
        "MALFORMED_DOCUMENT",
        "Whiteboard document version 1 is missing required fields",
      );
    }
  }

  if (
    object.type === "excalidraw" ||
    (Array.isArray(object.elements) &&
      !("assets" in object) &&
      !("metadata" in object)) ||
    (isObject(object.appState) &&
      !("assets" in object) &&
      !("metadata" in object))
  ) {
    validateLegacySourceVersion(object);
    return "legacy-excalidraw";
  }

  if (typeof object.version === "number") {
    throw new WhiteboardDocumentError(
      "UNSUPPORTED_VERSION",
      `Unsupported whiteboard document version ${object.version}`,
      "$.version",
    );
  }

  throw new WhiteboardDocumentError(
    "UNSUPPORTED_FORMAT",
    "Payload is not a Drawstuff or Excalidraw document",
  );
}

export function parsePersistedWhiteboardPayload(
  payload: unknown,
  options?: {
    readonly allowMissingAssets?: boolean;
  },
): PersistedWhiteboardPayload {
  const originalPayload =
    typeof payload === "string" ? payload : stableStringify(payload);
  const parsed = parseJsonInput(payload);
  const format = detectWhiteboardDocumentFormat(parsed);

  if (format === "whiteboard-v1") {
    return {
      format,
      document: parseWhiteboardDocumentV1(parsed, options),
    };
  }

  const legacy = parseLegacySceneForRuntime(expectObject(parsed, "$"));
  return {
    format,
    document: {
      ...legacy.document,
      persistence: {
        sourceFormat: "legacy-excalidraw",
        documentVersion: legacy.sourceVersion,
        legacyRollback: createLegacyRollbackEnvelope({
          originalPayload,
          sourceVersion: legacy.sourceVersion,
        }),
      },
    },
    originalPayload,
    sourceVersion: legacy.sourceVersion,
  };
}

export function parseWhiteboardDocumentV1(
  payload: unknown,
  options?: {
    readonly allowMissingAssets?: boolean;
  },
): WhiteboardDocumentV1 {
  const object = expectObject(parseJsonInput(payload), "$");
  if (object.version !== WHITEBOARD_DOCUMENT_VERSION) {
    const code =
      typeof object.version === "number"
        ? "UNSUPPORTED_VERSION"
        : "MALFORMED_DOCUMENT";
    throw new WhiteboardDocumentError(
      code,
      `Expected whiteboard document version ${WHITEBOARD_DOCUMENT_VERSION}`,
      "$.version",
    );
  }

  const elements = parseElements(object.elements, "$.elements");
  const assets = parseAssets(object.assets, "$.assets");
  const metadata = parseMetadata(object.metadata, "$.metadata");
  if (!options?.allowMissingAssets) {
    assertReferencedAssetsExist(elements, assets);
  }

  return {
    version: WHITEBOARD_DOCUMENT_VERSION,
    elements,
    assets,
    metadata,
  };
}

export function migrateLegacyExcalidrawScene(
  payload: unknown,
  options?: {
    readonly assets?: Readonly<Record<string, WhiteboardAsset>>;
  },
): WhiteboardDocumentV1 {
  // String inputs retain their exact bytes. Object inputs have no original
  // byte representation, so the rollback envelope stores a canonical snapshot.
  const originalPayload =
    typeof payload === "string" ? payload : stableStringify(payload);
  const parsed = parseJsonInput(payload);
  const object = expectObject(parsed, "$");
  if (detectWhiteboardDocumentFormat(object) !== "legacy-excalidraw") {
    throw new WhiteboardDocumentError(
      "UNSUPPORTED_FORMAT",
      "Only legacy Excalidraw scenes can be migrated",
    );
  }

  const legacy = parseLegacyScene(object);
  const externalAssets = options?.assets
    ? parseAssets(options.assets, "$.externalAssets")
    : {};
  const assets = filterReferencedWhiteboardAssets(
    legacy.document.elements,
    sortRecord({
      ...legacy.document.assets,
      ...externalAssets,
    }),
  );
  assertReferencedAssetsExist(legacy.document.elements, assets);

  return {
    version: WHITEBOARD_DOCUMENT_VERSION,
    elements: legacy.document.elements,
    assets,
    metadata: {
      ...metadataFromState(legacy.document.state),
      legacy: {
        format: "excalidraw",
        sourceVersion: legacy.sourceVersion,
        migrationVersion: LEGACY_MIGRATION_VERSION,
        originalPayload,
        unsupported: collectUnsupportedLegacyFields(object),
      },
    },
  };
}

export function createWhiteboardDocumentV1(
  {
    elements,
    assets,
    metadata,
  }: {
    readonly elements: readonly WhiteboardElement[];
    readonly assets: Readonly<Record<string, WhiteboardAsset>>;
    readonly metadata: WhiteboardDocumentMetadata;
  },
  options?: {
    readonly allowMissingAssets?: boolean;
  },
): WhiteboardDocumentV1 {
  return parseWhiteboardDocumentV1(
    {
      version: WHITEBOARD_DOCUMENT_VERSION,
      elements,
      assets,
      metadata,
    },
    options,
  );
}

export function serializeWhiteboardDocumentV1(
  document: WhiteboardDocumentV1,
  options?: {
    readonly allowMissingAssets?: boolean;
  },
): string {
  return stableStringify(parseWhiteboardDocumentV1(document, options));
}

export function filterReferencedWhiteboardAssets(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): Record<string, WhiteboardAsset> {
  const referencedIds = new Set<string>();
  for (const element of elements) {
    if (!element.isDeleted && typeof element.fileId === "string") {
      referencedIds.add(element.fileId);
    }
  }

  return Object.fromEntries(
    [...referencedIds]
      .sort()
      .flatMap((id) => (assets[id] ? [[id, assets[id]]] : [])),
  );
}

export function toRuntimeWhiteboardDocument(
  document: WhiteboardDocumentV1,
): WhiteboardDocument {
  return {
    elements: document.elements,
    assets: document.assets,
    state: {
      name: document.metadata.name,
      theme: document.metadata.theme,
      viewBackgroundColor: document.metadata.viewBackgroundColor,
      gridSize: document.metadata.gridSize,
      ...(document.metadata.viewport
        ? {
            scrollX: document.metadata.viewport.scrollX,
            scrollY: document.metadata.viewport.scrollY,
            zoom: { value: document.metadata.viewport.zoom },
          }
        : {}),
    },
    persistence: {
      sourceFormat: "whiteboard-v1",
      documentVersion: WHITEBOARD_DOCUMENT_VERSION,
      ...(document.metadata.legacy
        ? { legacyRollback: document.metadata.legacy }
        : {}),
    },
  };
}

export function prepareWhiteboardDocumentForOwnedEngine(
  document: WhiteboardDocument,
): WhiteboardDocument {
  if (document.persistence?.sourceFormat === "whiteboard-v1") {
    return document;
  }

  const legacyRollback =
    document.persistence?.legacyRollback ??
    createLegacyRollbackEnvelope({
      originalPayload: stableStringify({
        type: "excalidraw",
        version: 2,
        source: "https://drawstuff.app/rollback",
        elements: document.elements,
        appState: document.state,
        files: document.assets,
      }),
      sourceVersion: document.persistence?.documentVersion ?? 2,
    });

  return {
    ...document,
    persistence: {
      sourceFormat: "whiteboard-v1",
      documentVersion: WHITEBOARD_DOCUMENT_VERSION,
      legacyRollback,
      migratedFromLegacy: true,
    },
  };
}

export function createPersistedWhiteboardDocumentV1(
  document: WhiteboardDocument,
  options?: {
    readonly includeInlineAssets?: boolean;
    readonly retainLegacy?: boolean;
    readonly compactLegacyAssets?: boolean;
  },
): WhiteboardDocumentV1 {
  const legacyRollback =
    options?.retainLegacy === false
      ? undefined
      : options?.compactLegacyAssets
        ? compactLegacyRollback(document.persistence?.legacyRollback)
        : document.persistence?.legacyRollback;
  return createWhiteboardDocumentV1(
    {
      elements: document.elements,
      assets:
        options?.includeInlineAssets === false
          ? {}
          : filterReferencedWhiteboardAssets(
              document.elements,
              document.assets,
            ),
      metadata: {
        name:
          typeof document.state.name === "string" ? document.state.name : "",
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
        ...createPersistedViewport(document.state),
        ...(legacyRollback ? { legacy: legacyRollback } : {}),
      },
    },
    {
      allowMissingAssets: options?.includeInlineAssets === false,
    },
  );
}

export function getWhiteboardDocumentVersion(
  document: Pick<WhiteboardDocument, "persistence">,
): number | null {
  return document.persistence?.documentVersion ?? null;
}

function createLegacyRollbackEnvelope({
  originalPayload,
  sourceVersion,
}: {
  readonly originalPayload: string;
  readonly sourceVersion: number | null;
}): WhiteboardDocumentPersistence["legacyRollback"] {
  return {
    format: "excalidraw",
    sourceVersion,
    migrationVersion: LEGACY_MIGRATION_VERSION,
    originalPayload,
    unsupported: {},
  };
}

function compactLegacyRollback(
  rollback: WhiteboardDocumentPersistence["legacyRollback"],
): WhiteboardDocumentPersistence["legacyRollback"] {
  if (!rollback) return undefined;
  const payload = expectObject(parseJsonInput(rollback.originalPayload), "$");
  return {
    ...rollback,
    originalPayload: stableStringify({
      ...payload,
      files: {},
    }),
  };
}

function parseLegacyScene(object: JsonObject): {
  readonly document: WhiteboardDocument;
  readonly sourceVersion: number | null;
} {
  validateLegacySourceVersion(object);
  const elements = parseElements(object.elements, "$.elements", {
    legacyDefaults: true,
  });
  const state = parseLegacyState(object.appState, "$.appState");
  const assets =
    object.files === undefined
      ? {}
      : parseAssets(object.files, "$.files", { legacyDefaults: true });

  return {
    document: { elements, state, assets },
    sourceVersion: typeof object.version === "number" ? object.version : null,
  };
}

function parseLegacySceneForRuntime(object: JsonObject): {
  readonly document: WhiteboardDocument;
  readonly sourceVersion: number | null;
} {
  validateLegacySourceVersion(object);
  const reservedElementIds = new Set(
    Array.isArray(object.elements)
      ? object.elements.flatMap((element) =>
          isObject(element) &&
          typeof element.id === "string" &&
          element.id.length > 0
            ? [element.id]
            : [],
        )
      : [],
  );
  const elementIds = new Set<string>();
  const elements = Array.isArray(object.elements)
    ? object.elements.flatMap((element, index) => {
        if (!isObject(element) || typeof element.type !== "string") return [];
        try {
          assertJsonValue(element, "$.elements");
          const requestedId =
            typeof element.id === "string" && element.id.length > 0
              ? element.id
              : null;
          const id =
            requestedId && !elementIds.has(requestedId)
              ? requestedId
              : createUniqueLegacyElementId(
                  index,
                  reservedElementIds,
                  elementIds,
                );
          elementIds.add(id);
          return [
            {
              ...cloneJson(element),
              id,
              isDeleted:
                typeof element.isDeleted === "boolean"
                  ? element.isDeleted
                  : false,
            } as unknown as WhiteboardElement,
          ];
        } catch {
          return [];
        }
      })
    : [];
  const state = isObject(object.appState)
    ? parseLegacyState(object.appState, "$.appState")
    : {};
  const assets: Record<string, WhiteboardAsset> = {};
  if (isObject(object.files)) {
    for (const [id, asset] of Object.entries(object.files)) {
      if (!isObject(asset)) continue;
      try {
        Object.assign(
          assets,
          parseAssets(
            {
              [id]: {
                ...asset,
                id,
                created: asset.created ?? 0,
              },
            },
            "$.files",
            { legacyDefaults: true },
          ),
        );
      } catch {
        // A bad legacy file must not prevent the owned importer from loading
        // the remaining scene; unsafe file data is dropped at this boundary.
      }
    }
  }

  return {
    document: { elements, state, assets },
    sourceVersion: typeof object.version === "number" ? object.version : null,
  };
}

function createUniqueLegacyElementId(
  index: number,
  reservedIds: ReadonlySet<string>,
  usedIds: ReadonlySet<string>,
): string {
  let suffix = index;
  let id = `legacy-${suffix}`;
  while (reservedIds.has(id) || usedIds.has(id)) {
    suffix += 1;
    id = `legacy-${suffix}`;
  }
  return id;
}

function parseElements(
  value: unknown,
  path: string,
  options?: { readonly legacyDefaults?: boolean },
): WhiteboardElement[] {
  if (!Array.isArray(value)) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected an elements array",
      path,
    );
  }

  const ids = new Set<string>();
  return value.map((element, index) => {
    const elementPath = `${path}[${index}]`;
    const object = expectObject(element, elementPath);
    const id = expectString(object.id, `${elementPath}.id`);
    if (ids.has(id)) {
      throw new WhiteboardDocumentError(
        "MALFORMED_DOCUMENT",
        `Duplicate element id ${id}`,
        `${elementPath}.id`,
      );
    }
    ids.add(id);
    expectString(object.type, `${elementPath}.type`);
    const isDeleted =
      object.isDeleted === undefined && options?.legacyDefaults
        ? false
        : object.isDeleted;
    if (typeof isDeleted !== "boolean") {
      throw new WhiteboardDocumentError(
        "MALFORMED_DOCUMENT",
        "Expected isDeleted to be a boolean",
        `${elementPath}.isDeleted`,
      );
    }
    if (
      object.fileId !== undefined &&
      object.fileId !== null &&
      typeof object.fileId !== "string"
    ) {
      throw new WhiteboardDocumentError(
        "MALFORMED_DOCUMENT",
        "Expected fileId to be a string or null",
        `${elementPath}.fileId`,
      );
    }
    assertJsonValue(object, elementPath);
    return {
      ...cloneJson(object),
      isDeleted,
    } as unknown as WhiteboardElement;
  });
}

function parseAssets(
  value: unknown,
  path: string,
  options?: { readonly legacyDefaults?: boolean },
): Record<string, WhiteboardAsset> {
  const object = expectObject(value, path);
  const entries = Object.entries(object)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, asset]) => {
      const assetPath = `${path}.${escapePathSegment(key)}`;
      const assetObject = expectObject(asset, assetPath);
      const id = expectString(assetObject.id, `${assetPath}.id`);
      if (id !== key) {
        throw new WhiteboardDocumentError(
          "MALFORMED_DOCUMENT",
          `Asset id ${id} does not match record key ${key}`,
          `${assetPath}.id`,
        );
      }
      const dataURL = expectString(assetObject.dataURL, `${assetPath}.dataURL`);
      const mimeType = expectString(
        assetObject.mimeType,
        `${assetPath}.mimeType`,
      );
      validateAssetDataURL(dataURL, mimeType, assetPath);
      const parsedAsset: WhiteboardAsset = {
        id,
        dataURL,
        mimeType,
        created:
          assetObject.created === undefined && options?.legacyDefaults
            ? 0
            : expectFiniteNumber(assetObject.created, `${assetPath}.created`),
        ...(assetObject.lastRetrieved === undefined
          ? {}
          : {
              lastRetrieved: expectFiniteNumber(
                assetObject.lastRetrieved,
                `${assetPath}.lastRetrieved`,
              ),
            }),
        ...(assetObject.byteSize === undefined
          ? {}
          : {
              byteSize: expectNonNegativeNumber(
                assetObject.byteSize,
                `${assetPath}.byteSize`,
              ),
            }),
        ...(assetObject.contentHash === undefined
          ? {}
          : {
              contentHash: expectString(
                assetObject.contentHash,
                `${assetPath}.contentHash`,
              ),
            }),
        ...(assetObject.width === undefined
          ? {}
          : {
              width: expectPositiveNumber(
                assetObject.width,
                `${assetPath}.width`,
              ),
            }),
        ...(assetObject.height === undefined
          ? {}
          : {
              height: expectPositiveNumber(
                assetObject.height,
                `${assetPath}.height`,
              ),
            }),
      };
      return [key, parsedAsset] as const;
    });

  return Object.fromEntries(entries);
}

function parseMetadata(
  value: unknown,
  path: string,
): WhiteboardDocumentMetadata {
  const object = expectObject(value, path);
  const legacy =
    object.legacy === undefined
      ? undefined
      : parseLegacyEnvelope(object.legacy, `${path}.legacy`);
  const viewport =
    object.viewport === undefined
      ? undefined
      : parsePersistedViewport(object.viewport, `${path}.viewport`);

  return {
    name: expectString(object.name, `${path}.name`),
    theme: parseTheme(object.theme, `${path}.theme`),
    viewBackgroundColor: expectString(
      object.viewBackgroundColor,
      `${path}.viewBackgroundColor`,
    ),
    gridSize: parseGridSize(object.gridSize, `${path}.gridSize`),
    ...(viewport ? { viewport } : {}),
    ...(legacy ? { legacy } : {}),
  };
}

function parseLegacyEnvelope(
  value: unknown,
  path: string,
): NonNullable<WhiteboardDocumentMetadata["legacy"]> {
  const object = expectObject(value, path);
  if (object.format !== "excalidraw") {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected legacy format to be excalidraw",
      `${path}.format`,
    );
  }
  if (object.migrationVersion !== LEGACY_MIGRATION_VERSION) {
    throw new WhiteboardDocumentError(
      "UNSUPPORTED_VERSION",
      `Unsupported legacy migration version ${String(object.migrationVersion)}`,
      `${path}.migrationVersion`,
    );
  }
  const sourceVersion =
    object.sourceVersion === null
      ? null
      : expectFiniteNumber(object.sourceVersion, `${path}.sourceVersion`);
  const unsupportedObject = expectObject(
    object.unsupported,
    `${path}.unsupported`,
  );
  assertJsonValue(unsupportedObject, `${path}.unsupported`);

  return {
    format: "excalidraw",
    sourceVersion,
    migrationVersion: LEGACY_MIGRATION_VERSION,
    originalPayload: expectString(
      object.originalPayload,
      `${path}.originalPayload`,
    ),
    unsupported: sortRecord(
      cloneJson(unsupportedObject) as Record<string, WhiteboardJsonValue>,
    ),
  };
}

function parseLegacyState(
  value: unknown,
  path: string,
): WhiteboardDocumentState {
  if (value === null || value === undefined) {
    return {};
  }
  const object = expectObject(value, path);
  assertJsonValue(object, path);
  return cloneJson(object);
}

function metadataFromState(
  state: WhiteboardDocumentState,
): WhiteboardDocumentMetadata {
  return {
    name: typeof state.name === "string" ? state.name : "",
    theme: state.theme === "dark" ? "dark" : "light",
    viewBackgroundColor:
      typeof state.viewBackgroundColor === "string"
        ? state.viewBackgroundColor
        : "#ffffff",
    gridSize:
      typeof state.gridSize === "number" && Number.isFinite(state.gridSize)
        ? state.gridSize
        : null,
    ...createPersistedViewport(state),
  };
}

function createPersistedViewport(
  state: WhiteboardDocumentState,
): Pick<WhiteboardDocumentMetadata, "viewport"> {
  const zoom = state.zoom?.value;
  if (
    typeof state.scrollX !== "number" ||
    !Number.isFinite(state.scrollX) ||
    typeof state.scrollY !== "number" ||
    !Number.isFinite(state.scrollY) ||
    typeof zoom !== "number" ||
    !Number.isFinite(zoom) ||
    zoom <= 0
  ) {
    return {};
  }
  return {
    viewport: {
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      zoom,
    },
  };
}

function parsePersistedViewport(
  value: unknown,
  path: string,
): NonNullable<WhiteboardDocumentMetadata["viewport"]> {
  const object = expectObject(value, path);
  return {
    scrollX: expectFiniteNumber(object.scrollX, `${path}.scrollX`),
    scrollY: expectFiniteNumber(object.scrollY, `${path}.scrollY`),
    zoom: expectPositiveNumber(object.zoom, `${path}.zoom`),
  };
}

function assertReferencedAssetsExist(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): void {
  for (const [index, element] of elements.entries()) {
    if (
      element.isDeleted ||
      element.type !== "image" ||
      element.fileId === null ||
      element.fileId === undefined
    ) {
      continue;
    }
    if (!assets[element.fileId]) {
      throw new WhiteboardDocumentError(
        "MISSING_ASSET",
        `Image element ${element.id} references missing asset ${element.fileId}`,
        `$.elements[${index}].fileId`,
      );
    }
  }
}

function collectUnsupportedLegacyFields(
  object: JsonObject,
): Record<string, WhiteboardJsonValue> {
  const unsupported: Record<string, WhiteboardJsonValue> = {};
  collectUnknownObjectFields(
    object,
    KNOWN_LEGACY_TOP_LEVEL_FIELDS,
    "$",
    unsupported,
  );

  if (isObject(object.appState)) {
    collectUnknownObjectFields(
      object.appState,
      KNOWN_LEGACY_APP_STATE_FIELDS,
      "$.appState",
      unsupported,
    );
  }

  if (Array.isArray(object.elements)) {
    object.elements.forEach((element, index) => {
      if (!isObject(element)) return;
      collectUnknownObjectFields(
        element,
        KNOWN_LEGACY_ELEMENT_FIELDS,
        `$.elements[${index}]`,
        unsupported,
      );
      if (
        typeof element.type === "string" &&
        !SUPPORTED_LEGACY_ELEMENT_TYPES.has(element.type)
      ) {
        unsupported[`$.elements[${index}]`] = cloneJson(
          element,
        ) as WhiteboardJsonValue;
      }
    });
  }

  if (isObject(object.files)) {
    for (const [id, asset] of Object.entries(object.files)) {
      if (!isObject(asset)) continue;
      collectUnknownObjectFields(
        asset,
        KNOWN_LEGACY_ASSET_FIELDS,
        `$.files.${escapePathSegment(id)}`,
        unsupported,
      );
    }
  }

  return sortRecord(unsupported);
}

function collectUnknownObjectFields(
  object: JsonObject,
  knownFields: ReadonlySet<string>,
  path: string,
  output: Record<string, WhiteboardJsonValue>,
): void {
  for (const key of Object.keys(object).sort()) {
    if (knownFields.has(key)) continue;
    const value = object[key];
    if (value === undefined) continue;
    assertJsonValue(value, `${path}.${escapePathSegment(key)}`);
    output[`${path}.${escapePathSegment(key)}`] = cloneJson(
      value,
    ) as WhiteboardJsonValue;
  }
}

function validateLegacySourceVersion(object: JsonObject): void {
  if (
    object.type === "excalidraw" &&
    object.version !== undefined &&
    object.version !== 1 &&
    object.version !== 2
  ) {
    throw new WhiteboardDocumentError(
      "UNSUPPORTED_VERSION",
      `Unsupported Excalidraw document version ${describeUnknown(object.version)}`,
      "$.version",
    );
  }
}

function validateAssetDataURL(
  dataURL: string,
  mimeType: string,
  path: string,
): void {
  const normalizedMimeType = mimeType.toLowerCase();
  const mediaTypeEnd = dataURL.search(/[;,]/);
  const dataURLMimeType =
    dataURL.startsWith("data:") && mediaTypeEnd > 5
      ? dataURL.slice(5, mediaTypeEnd).toLowerCase()
      : "";
  if (
    normalizedMimeType === "application/octet-stream" &&
    SUPPORTED_ASSET_MIME_TYPES.has(dataURLMimeType)
  ) {
    return;
  }
  if (!SUPPORTED_ASSET_MIME_TYPES.has(normalizedMimeType)) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      `Unsupported asset MIME type ${mimeType}`,
      `${path}.mimeType`,
    );
  }

  if (dataURLMimeType !== normalizedMimeType) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Asset dataURL must be an inline image matching mimeType",
      `${path}.dataURL`,
    );
  }
}

function parseJsonInput(payload: unknown): unknown {
  if (typeof payload !== "string") {
    return payload;
  }
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
  if (!isObject(value)) {
    throw new WhiteboardDocumentError(
      "MALFORMED_DOCUMENT",
      "Expected an object",
      path,
    );
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseGridSize(value: unknown, path: string): number | null {
  if (value === null) return null;
  return expectFiniteNumber(value, path);
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
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      assertJsonValue(item, `${path}.${escapePathSegment(key)}`);
    }
    return;
  }
  throw new WhiteboardDocumentError(
    "MALFORMED_DOCUMENT",
    "Expected JSON-compatible data",
    path,
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareKeys(left, right)),
  );
}

function stableStringify(value: unknown): string {
  assertJsonValue(value, "$");
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function escapePathSegment(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
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

function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
