import {
  clearElementsForOfficialExport,
  EXCALIDRAW_PERSISTENCE_CONTRACT,
  filterReferencedFiles,
  selectOfficialServerAppState,
  type ExcalidrawStorageProfile,
} from "./persistence-contract.ts";
import type { AppState, BinaryFiles, ExcalidrawElement } from "./types.ts";

export const DRAWSTUFF_DOCUMENT_VERSION = 4 as const;

interface DrawstuffAssetMetadata {
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

export interface OfficialExcalidrawExport {
  readonly type: "excalidraw";
  readonly version: typeof EXCALIDRAW_PERSISTENCE_CONTRACT.upstreamFormatVersion;
  readonly source: string;
  readonly elements: readonly unknown[];
  readonly appState: Readonly<Record<string, unknown>>;
  readonly files?: BinaryFiles;
}

type JsonObject = Record<string, unknown>;

export function createDrawstuffDocumentV4(input: {
  readonly elements: readonly ExcalidrawElement[] | readonly unknown[];
  readonly appState: Partial<AppState> | Readonly<Record<string, unknown>>;
  readonly files?: BinaryFiles;
  readonly name?: string;
  readonly profile?: Extract<
    ExcalidrawStorageProfile,
    "owned-scene" | "readonly-share"
  >;
}): DrawstuffDocumentV4 {
  const appState = objectOrEmpty(input.appState);
  const profile = input.profile ?? "owned-scene";
  return {
    version: DRAWSTUFF_DOCUMENT_VERSION,
    engine: {
      name: "excalidraw",
    },
    scene: {
      // Elements are deliberately not projected onto an application-owned
      // shape. Native collaboration fields and future unknown fields must
      // survive unchanged.
      elements:
        profile === "readonly-share"
          ? clearElementsForOfficialExport(input.elements)
          : input.elements,
      appState: selectOfficialServerAppState(appState),
    },
    assets: profile === "owned-scene" ? assetMetadata(input.files) : {},
    metadata: {
      name: normalizeName(input.name ?? appState.name),
    },
  };
}

export function createOwnedSceneDocumentV4(
  input: Omit<Parameters<typeof createDrawstuffDocumentV4>[0], "profile">,
): DrawstuffDocumentV4 {
  return createDrawstuffDocumentV4({ ...input, profile: "owned-scene" });
}

export function createReadonlyShareDocumentV4(
  input: Omit<Parameters<typeof createDrawstuffDocumentV4>[0], "profile">,
): DrawstuffDocumentV4 {
  return createDrawstuffDocumentV4({ ...input, profile: "readonly-share" });
}

export function createLocalExportDocument(input: {
  readonly elements: readonly ExcalidrawElement[] | readonly unknown[];
  readonly appState: Partial<AppState> | Readonly<Record<string, unknown>>;
  readonly files?: BinaryFiles;
  readonly source: string;
}): OfficialExcalidrawExport {
  return {
    type: "excalidraw",
    version: EXCALIDRAW_PERSISTENCE_CONTRACT.upstreamFormatVersion,
    source: input.source,
    elements: clearElementsForOfficialExport(input.elements),
    appState: selectOfficialServerAppState(input.appState),
    files: filterReferencedFiles(input.elements, input.files ?? {}),
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
    // Documents are returned in the single canonical V4 shape. Fields that
    // older writers emitted (`engine.version`, non-contract `appState` keys
    // such as `theme`) are not part of the document any more, so they are
    // dropped instead of being carried forward on the next write.
    return {
      version: DRAWSTUFF_DOCUMENT_VERSION,
      engine: { name: "excalidraw" },
      scene: {
        elements: parsed.scene.elements,
        appState: selectOfficialServerAppState(parsed.scene.appState),
      },
      assets: parsed.assets,
      metadata: { name: parsed.metadata.name },
    };
  }
  if (isOwnedWhiteboardV3(parsed)) {
    throw new Error(
      "Owned Whiteboard V3 documents are no longer readable; they were " +
        "rewritten to Drawstuff V4 on 2026-08-01",
    );
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
  if (!isObject(value.engine) || value.engine.name !== "excalidraw") {
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

/**
 * Owned Whiteboard V3 was rewritten to V4 in production, so the reader is
 * gone. V3 payloads still carry a top-level `elements` array, so they are
 * rejected explicitly instead of falling through to the raw `.excalidraw`
 * reader, which would misread their renamed fields.
 */
function isOwnedWhiteboardV3(value: unknown): boolean {
  return (
    isObject(value) &&
    value.type !== "excalidraw" &&
    value.version === 3 &&
    Array.isArray(value.elements)
  );
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
