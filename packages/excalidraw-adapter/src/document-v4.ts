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

export type DrawstuffDocumentParseError = {
  code: "malformed-json" | "unsupported-payload";
  detail: string;
};

export type ParseDrawstuffDocumentResult =
  | { ok: true; document: DrawstuffDocumentV4 }
  | { ok: false; error: DrawstuffDocumentParseError };

export function serializeDrawstuffDocumentV4(
  document: DrawstuffDocumentV4,
): string {
  return JSON.stringify(canonicalize(document));
}

export function parseDrawstuffDocument(
  payload: unknown,
): ParseDrawstuffDocumentResult {
  let parsed: unknown;
  try {
    parsed = parseJson(payload);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-json",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  // V4 is the only stored shape: every pre-V4 row was rewritten on
  // 2026-08-01 and a 2026-09-04 audit of stored documents found none left, so
  // anything else — including a raw `.excalidraw` payload — is refused rather
  // than upgraded on read. Disk imports go through the adapter's import path,
  // never through this reader.
  if (isDrawstuffDocumentV4(parsed)) {
    return { ok: true, document: canonicalize(parsed) };
  }
  return {
    ok: false,
    error: {
      code: "unsupported-payload",
      detail: "Unsupported Drawstuff document payload",
    },
  };
}

/**
 * Documents are returned in the single canonical V4 shape. Fields that
 * older writers emitted (`engine.version`, non-contract `appState` keys
 * such as `theme`) are not part of the document any more, so they are
 * dropped instead of being carried forward on the next write.
 */
function canonicalize(document: DrawstuffDocumentV4): DrawstuffDocumentV4 {
  return {
    version: DRAWSTUFF_DOCUMENT_VERSION,
    engine: { name: "excalidraw" },
    scene: {
      elements: document.scene.elements,
      appState: selectOfficialServerAppState(document.scene.appState),
    },
    assets: canonicalAssets(document.assets),
    metadata: { name: document.metadata.name },
  };
}

/**
 * Asset entries get the same treatment as `appState`: only the contract
 * fields survive canonicalization, so an entry that carries anything extra
 * loses it on the next read instead of ferrying it forward forever.
 */
function canonicalAssets(
  assets: Readonly<Record<string, DrawstuffAssetMetadata>>,
): Readonly<Record<string, DrawstuffAssetMetadata>> {
  return Object.fromEntries(
    Object.entries(assets).map(([key, entry]) => [
      key,
      {
        id: entry.id,
        storage: entry.storage,
        ...(entry.mimeType !== undefined && { mimeType: entry.mimeType }),
        ...(entry.created !== undefined && { created: entry.created }),
        ...(entry.lastRetrieved !== undefined && {
          lastRetrieved: entry.lastRetrieved,
        }),
      },
    ]),
  );
}

export function toNativeExcalidrawScene(document: DrawstuffDocumentV4): {
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Partial<AppState>;
} {
  const parsed = canonicalize(document);
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
  if (!Object.values(value.assets).every(isAssetMetadata)) {
    return false;
  }
  return typeof value.metadata.name === "string";
}

/**
 * The one part of a V4 document the reader used to accept unchecked. Every
 * field the asset relation depends on is pinned to its contract type; a
 * document whose `assets` map breaks any of them is not a V4 document, the
 * same answer any other malformed section gets. Fields beyond the contract
 * are tolerated here and dropped by `canonicalAssets`.
 */
function isAssetMetadata(value: unknown): value is DrawstuffAssetMetadata {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.storage !== "external") return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") {
    return false;
  }
  if (value.created !== undefined && typeof value.created !== "number") {
    return false;
  }
  return (
    value.lastRetrieved === undefined || typeof value.lastRetrieved === "number"
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
