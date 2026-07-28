import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export const DRAWSTUFF_DOCUMENT_VERSION = 4 as const;
export const DRAWSTUFF_EXCALIDRAW_VERSION = "0.18.1" as const;

export interface DrawstuffAssetMetadata {
  readonly id: string;
  readonly mimeType?: string;
  readonly created?: number;
  readonly lastRetrieved?: number;
  readonly storage: "external";
}

export interface DrawstuffDocumentV4 {
  readonly version: typeof DRAWSTUFF_DOCUMENT_VERSION;
  readonly engine: {
    readonly name: "excalidraw";
    readonly version: typeof DRAWSTUFF_EXCALIDRAW_VERSION;
  };
  readonly scene: {
    readonly elements: readonly unknown[];
    readonly appState: Readonly<Record<string, unknown>>;
  };
  readonly assets: Readonly<Record<string, DrawstuffAssetMetadata>>;
  readonly metadata: {
    readonly name: string;
  };
}

type JsonObject = Record<string, unknown>;

export function createDrawstuffDocumentV4(input: {
  readonly elements: readonly ExcalidrawElement[] | readonly unknown[];
  readonly appState: Partial<AppState> | Readonly<Record<string, unknown>>;
  readonly files?: BinaryFiles;
  readonly name?: string;
}): DrawstuffDocumentV4 {
  const appState = objectOrEmpty(input.appState);
  return {
    version: DRAWSTUFF_DOCUMENT_VERSION,
    engine: {
      name: "excalidraw",
      version: DRAWSTUFF_EXCALIDRAW_VERSION,
    },
    scene: {
      // Elements are deliberately not projected onto an application-owned
      // shape. Native collaboration fields and future unknown fields must
      // survive unchanged.
      elements: input.elements,
      appState: sharedAppState(appState),
    },
    assets: assetMetadata(input.files),
    metadata: {
      name: normalizeName(input.name ?? appState.name),
    },
  };
}

export function serializeDrawstuffDocumentV4(
  document: DrawstuffDocumentV4,
): string {
  return JSON.stringify(parseDrawstuffDocument(document));
}

export function parseDrawstuffDocument(payload: unknown): DrawstuffDocumentV4 {
  const parsed = parseJson(payload);
  if (isDrawstuffDocumentV4(parsed)) {
    return parsed;
  }
  if (isOwnedWhiteboardV3(parsed)) {
    return convertOwnedWhiteboardV3(parsed);
  }
  if (isLegacyExcalidrawPayload(parsed)) {
    return createDrawstuffDocumentV4({
      elements: parsed.elements,
      appState: objectOrEmpty(parsed.appState),
      name: objectOrEmpty(parsed.appState).name as string | undefined,
    });
  }
  throw new Error("Unsupported Drawstuff document payload");
}

export function toNativeExcalidrawScene(document: DrawstuffDocumentV4): {
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Partial<AppState>;
} {
  const parsed = parseDrawstuffDocument(document);
  return {
    elements: parsed.scene.elements as readonly ExcalidrawElement[],
    appState: {
      ...(parsed.scene.appState as Partial<AppState>),
      name: parsed.metadata.name,
    },
  };
}

function isDrawstuffDocumentV4(value: unknown): value is DrawstuffDocumentV4 {
  if (!isObject(value) || value.version !== DRAWSTUFF_DOCUMENT_VERSION) {
    return false;
  }
  if (
    !isObject(value.engine) ||
    value.engine.name !== "excalidraw" ||
    value.engine.version !== DRAWSTUFF_EXCALIDRAW_VERSION
  ) {
    return false;
  }
  if (
    !isObject(value.scene) ||
    !Array.isArray(value.scene.elements) ||
    !isObject(value.scene.appState)
  ) {
    return false;
  }
  if (!isObject(value.assets) || !isObject(value.metadata)) {
    return false;
  }
  return typeof value.metadata.name === "string";
}

function isLegacyExcalidrawPayload(value: unknown): value is {
  readonly elements: readonly unknown[];
  readonly appState?: unknown;
} {
  return isObject(value) && Array.isArray(value.elements);
}

type OwnedWhiteboardV3 = {
  readonly version: 3;
  readonly elements: readonly JsonObject[];
  readonly assets?: Readonly<Record<string, unknown>>;
  readonly metadata?: JsonObject;
};

function isOwnedWhiteboardV3(value: unknown): value is OwnedWhiteboardV3 {
  return (
    isObject(value) &&
    value.version === 3 &&
    Array.isArray(value.elements) &&
    value.elements.every(isObject)
  );
}

function convertOwnedWhiteboardV3(
  document: OwnedWhiteboardV3,
): DrawstuffDocumentV4 {
  const metadata = objectOrEmpty(document.metadata);
  const elements = document.elements.map((element) => {
    const { updatedAt, roundness, ...rest } = element;
    return {
      ...rest,
      // Whiteboard V3 renamed Excalidraw's native `updated` field and
      // discarded other native properties. Keep the full V3 source under
      // customData so the lossy historical payload remains auditable.
      updated: typeof updatedAt === "number" ? updatedAt : 0,
      roundness:
        roundness === "round"
          ? { type: 3 }
          : roundness === "sharp"
            ? null
            : roundness,
      boundElements: Array.isArray(element.boundElements)
        ? element.boundElements
        : null,
      link: typeof element.link === "string" ? element.link : null,
      customData: {
        ...objectOrEmpty(element.customData),
        drawstuffWhiteboardV3: element,
      },
    };
  });

  return {
    ...createDrawstuffDocumentV4({
      elements,
      appState: {
        theme: metadata.theme,
        viewBackgroundColor: metadata.viewBackgroundColor,
        gridSize: metadata.gridSize,
      },
      name: typeof metadata.name === "string" ? metadata.name : "Untitled",
    }),
    assets: convertV3Assets(document.assets),
  };
}

function sharedAppState(
  appState: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ...(appState.theme !== undefined ? { theme: appState.theme } : {}),
    ...(appState.viewBackgroundColor !== undefined
      ? { viewBackgroundColor: appState.viewBackgroundColor }
      : {}),
    ...(appState.gridSize !== undefined ? { gridSize: appState.gridSize } : {}),
    ...(appState.gridStep !== undefined ? { gridStep: appState.gridStep } : {}),
    ...(appState.gridModeEnabled !== undefined
      ? { gridModeEnabled: appState.gridModeEnabled }
      : {}),
  };
}

function assetMetadata(
  files: BinaryFiles | undefined,
): Readonly<Record<string, DrawstuffAssetMetadata>> {
  if (!files) return {};
  return Object.fromEntries(
    Object.entries(files).map(([id, file]) => [
      id,
      {
        id,
        mimeType: file.mimeType,
        created: file.created,
        lastRetrieved: file.lastRetrieved,
        storage: "external" as const,
      },
    ]),
  );
}

function convertV3Assets(
  assets: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, DrawstuffAssetMetadata>> {
  if (!assets) return {};
  return Object.fromEntries(
    Object.entries(assets).map(([id, value]) => {
      const asset = objectOrEmpty(value);
      return [
        id,
        {
          id,
          ...(typeof asset.mimeType === "string"
            ? { mimeType: asset.mimeType }
            : {}),
          ...(typeof asset.created === "number"
            ? { created: asset.created }
            : {}),
          ...(typeof asset.lastRetrieved === "number"
            ? { lastRetrieved: asset.lastRetrieved }
            : {}),
          storage: "external" as const,
        },
      ];
    }),
  );
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

function objectOrEmpty(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "Untitled";
}
