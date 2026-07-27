import type {
  WhiteboardDocument,
  WhiteboardDocumentV2,
  WhiteboardPersistenceFormat,
} from "./contracts";
import {
  createPersistedWhiteboardDocumentV2,
  parseWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
} from "./canonical-document";
import {
  detectWhiteboardDocumentFormat,
  migrateLegacyExcalidrawScene,
  parseWhiteboardDocumentV1,
  toRuntimeWhiteboardDocument,
} from "./document-format";
import { WhiteboardDocumentError } from "./document-errors";

const V1_ROOT_FIELDS = new Set(["assets", "elements", "metadata", "version"]);
const V1_METADATA_FIELDS = new Set([
  "gridSize",
  "legacy",
  "name",
  "theme",
  "viewBackgroundColor",
]);
const V1_ASSET_FIELDS = new Set([
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

export type WhiteboardConversionSourceFormat =
  "legacy-excalidraw" | "whiteboard-v1" | "whiteboard-v2";

export interface WhiteboardConversionReport {
  readonly sourceFormat: WhiteboardConversionSourceFormat;
  readonly unsupportedFields: readonly string[];
  readonly unsupportedElements: readonly string[];
  readonly missingAssets: readonly string[];
}

export interface WhiteboardConversionResult {
  readonly document: WhiteboardDocumentV2;
  readonly report: WhiteboardConversionReport;
}

export class WhiteboardConversionError extends WhiteboardDocumentError {
  public constructor(
    code: "MISSING_ASSET" | "UNSUPPORTED_ELEMENT" | "UNSUPPORTED_FIELD",
    message: string,
    path: string,
    public readonly report: WhiteboardConversionReport,
  ) {
    super(code, message, path);
    this.name = "WhiteboardConversionError";
  }
}

/**
 * Temporary Phase 5L deletion boundary. It is the only product helper allowed
 * to read V1 or Excalidraw and it always returns a fully validated V2.
 */
export function convertPersistedWhiteboardDocumentToV2(
  payload: unknown,
  options?: {
    /**
     * Old database rows stored image bytes in file_record. The caller must
     * hydrate those records after conversion; portable imports never set this.
     */
    readonly externalAssets?: boolean;
  },
): WhiteboardConversionResult {
  const parsedPayload = parseJsonForDetection(payload);
  if (looksLikeV2(parsedPayload)) {
    return {
      document: parseWhiteboardDocumentV2(parsedPayload),
      report: emptyReport("whiteboard-v2"),
    };
  }

  const format = detectWhiteboardDocumentFormat(parsedPayload);
  const v1 =
    format === "whiteboard-v1"
      ? parseWhiteboardDocumentV1(parsedPayload, {
          allowMissingAssets: true,
        })
      : migrateLegacyExcalidrawScene(parsedPayload, {
          allowMissingAssets: true,
        });
  const unsupported = v1.metadata.legacy?.unsupported ?? {};
  const unsupportedElements = Object.entries(unsupported)
    .filter(
      ([path, value]) =>
        /^\$\.elements\[\d+\]$/.test(path) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { type?: unknown }).type === "string",
    )
    .map(([path]) => path)
    .sort();
  const unsupportedFields = [
    ...Object.keys(unsupported).filter(
      (path) => !unsupportedElements.includes(path),
    ),
    ...(format === "whiteboard-v1"
      ? collectUnsupportedV1Fields(parsedPayload)
      : []),
  ].sort();
  const initialReport: WhiteboardConversionReport = {
    sourceFormat: format,
    unsupportedFields,
    unsupportedElements,
    missingAssets: [],
  };
  if (unsupportedElements.length > 0) {
    throw new WhiteboardConversionError(
      "UNSUPPORTED_ELEMENT",
      `Conversion refused ${unsupportedElements.length} unsupported element${unsupportedElements.length === 1 ? "" : "s"}`,
      unsupportedElements[0]!,
      initialReport,
    );
  }
  if (unsupportedFields.length > 0) {
    throw new WhiteboardConversionError(
      "UNSUPPORTED_FIELD",
      `Conversion refused ${unsupportedFields.length} unsupported field${unsupportedFields.length === 1 ? "" : "s"}`,
      unsupportedFields[0]!,
      initialReport,
    );
  }

  const runtime = toRuntimeWhiteboardDocument(v1);
  const missingAssets = runtime.elements.flatMap((element) =>
    !element.isDeleted &&
    element.type === "image" &&
    typeof element.fileId === "string" &&
    !runtime.assets[element.fileId]
      ? [element.fileId]
      : [],
  );
  if (missingAssets.length > 0 && options?.externalAssets !== true) {
    const report = { ...initialReport, missingAssets };
    throw new WhiteboardConversionError(
      "MISSING_ASSET",
      `Conversion refused missing asset ${missingAssets[0]}`,
      "$.assets",
      report,
    );
  }

  let document: WhiteboardDocumentV2;
  try {
    document = createPersistedWhiteboardDocumentV2(runtime, {
      assetStorage: "inline",
      ...(options?.externalAssets
        ? { externalAssetIds: new Set(missingAssets) }
        : {}),
    });
  } catch (error) {
    if (
      error instanceof WhiteboardDocumentError &&
      (error.code === "UNSUPPORTED_ELEMENT" ||
        error.code === "UNSUPPORTED_FIELD")
    ) {
      const report = {
        ...initialReport,
        unsupportedElements:
          error.code === "UNSUPPORTED_ELEMENT" ? [error.path] : [],
        unsupportedFields:
          error.code === "UNSUPPORTED_FIELD" ? [error.path] : [],
      };
      throw new WhiteboardConversionError(
        error.code,
        error.message.replace(/ at .*$/, ""),
        error.path,
        report,
      );
    }
    throw error;
  }
  return {
    document,
    report: {
      ...initialReport,
      missingAssets: options?.externalAssets ? missingAssets : [],
    },
  };
}

export function parseWhiteboardDocumentForImport(
  payload: unknown,
  options?: {
    readonly externalAssets?: boolean;
  },
): WhiteboardDocument {
  const converted = convertPersistedWhiteboardDocumentToV2(payload, options);
  const runtime = toRuntimeWhiteboardDocumentV2(converted.document);
  const convertedFrom =
    converted.report.sourceFormat === "whiteboard-v2"
      ? undefined
      : (converted.report.sourceFormat satisfies Exclude<
          WhiteboardPersistenceFormat,
          "whiteboard-v2"
        >);
  return {
    ...runtime,
    ...(convertedFrom
      ? {
          persistence: {
            ...runtime.persistence!,
            convertedFrom,
            migratedFromLegacy: convertedFrom === "legacy-excalidraw",
          },
        }
      : {}),
  };
}

function looksLikeV2(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { version?: unknown; type?: unknown }).version === 2 &&
    (payload as { type?: unknown }).type !== "excalidraw"
  );
}

function collectUnsupportedV1Fields(payload: unknown): readonly string[] {
  if (!isRecord(payload)) return [];
  const fields = collectUnknownFields(payload, V1_ROOT_FIELDS, "$");
  if (isRecord(payload.metadata)) {
    fields.push(
      ...collectUnknownFields(
        payload.metadata,
        V1_METADATA_FIELDS,
        "$.metadata",
      ),
    );
  }
  if (isRecord(payload.assets)) {
    for (const [id, asset] of Object.entries(payload.assets)) {
      if (!isRecord(asset)) continue;
      fields.push(
        ...collectUnknownFields(
          asset,
          V1_ASSET_FIELDS,
          `$.assets.${escapePathSegment(id)}`,
        ),
      );
    }
  }
  return fields.sort();
}

function collectUnknownFields(
  object: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
): string[] {
  return Object.keys(object)
    .filter((key) => !allowed.has(key))
    .map((key) => `${path}.${escapePathSegment(key)}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePathSegment(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
}

function parseJsonForDetection(payload: unknown): unknown {
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

function emptyReport(
  sourceFormat: WhiteboardConversionSourceFormat,
): WhiteboardConversionReport {
  return {
    sourceFormat,
    unsupportedFields: [],
    unsupportedElements: [],
    missingAssets: [],
  };
}
