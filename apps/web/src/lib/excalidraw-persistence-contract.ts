import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export const EXCALIDRAW_PERSISTENCE_CONTRACT = {
  packageVersion: "0.18.1",
  upstreamTag: "v0.18.1",
  upstreamCommit: "a2ec2889babf7d2295469c6d90ebe77fae57df84",
  upstreamFormatVersion: 2,
  deletedElementRetentionMs: 24 * 60 * 60 * 1000,
} as const;

export const OFFICIAL_SERVER_APP_STATE_KEYS = [
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "viewBackgroundColor",
] as const satisfies readonly (keyof AppState)[];

export type ExcalidrawStorageProfile =
  "owned-scene" | "readonly-share" | "local-export" | "collaboration-snapshot";

export const EXCALIDRAW_STORAGE_PROFILE_MATRIX = {
  "owned-scene": {
    elements: "native-with-tombstones",
    appState: "official-server-allowlist",
    files: "external-metadata-only",
  },
  "readonly-share": {
    elements: "official-database-cleaner",
    appState: "official-server-allowlist",
    files: "separate-encrypted-storage",
  },
  "local-export": {
    elements: "official-export-cleaner",
    appState: "official-export-allowlist",
    files: "referenced-non-deleted-files",
  },
  "collaboration-snapshot": {
    elements: "official-syncable-elements",
    appState: "none",
    files: "separate-encrypted-storage",
  },
} as const satisfies Record<
  ExcalidrawStorageProfile,
  {
    readonly elements: string;
    readonly appState: string;
    readonly files: string;
  }
>;

type JsonObject = Record<string, unknown>;

export function selectOfficialServerAppState(
  appState: Partial<AppState> | Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const source = objectOrEmpty(appState);
  return Object.fromEntries(
    OFFICIAL_SERVER_APP_STATE_KEYS.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

export function clearElementsForOfficialExport(
  elements: readonly ExcalidrawElement[] | readonly unknown[],
): readonly unknown[] {
  return elements
    .filter((element) => !objectOrEmpty(element).isDeleted)
    .map((element) => {
      const value = objectOrEmpty(element);
      return value.type === "line" || value.type === "arrow"
        ? { ...value, lastCommittedPoint: null }
        : element;
    });
}

export function getOfficialSyncableElements(
  elements: readonly ExcalidrawElement[] | readonly unknown[],
  now = Date.now(),
): readonly unknown[] {
  const deletedAfter =
    now - EXCALIDRAW_PERSISTENCE_CONTRACT.deletedElementRetentionMs;

  return elements.filter((element) => {
    const value = objectOrEmpty(element);
    if (value.isDeleted) {
      return typeof value.updated === "number" && value.updated > deletedAfter;
    }
    return !isInvisiblySmallElement(value);
  });
}

export function filterReferencedFiles(
  elements: readonly ExcalidrawElement[] | readonly unknown[],
  files: BinaryFiles,
): BinaryFiles {
  const referencedFiles: BinaryFiles = {};
  for (const element of elements) {
    const value = objectOrEmpty(element);
    const fileId = value.fileId;
    if (!value.isDeleted && typeof fileId === "string" && fileId in files) {
      referencedFiles[fileId as keyof BinaryFiles] =
        files[fileId as keyof BinaryFiles]!;
    }
  }
  return referencedFiles;
}

export type ExcalidrawFileRecordMapping = {
  readonly excalidrawFileId: string | null | undefined;
};

export type AssetReferenceReport = {
  readonly referencedFileIds: readonly string[];
  readonly missingFileIds: readonly string[];
  readonly duplicateFileIds: readonly string[];
  readonly unreferencedFileIds: readonly string[];
};

export function inspectAssetReferences(
  elements: readonly ExcalidrawElement[] | readonly unknown[],
  records: readonly ExcalidrawFileRecordMapping[],
): AssetReferenceReport {
  const referenced = new Set<string>();
  for (const element of elements) {
    const value = objectOrEmpty(element);
    if (
      !value.isDeleted &&
      value.type === "image" &&
      typeof value.fileId === "string" &&
      value.fileId.length > 0
    ) {
      referenced.add(value.fileId);
    }
  }

  const counts = new Map<string, number>();
  for (const record of records) {
    const fileId = record.excalidrawFileId;
    if (typeof fileId === "string" && fileId.length > 0) {
      counts.set(fileId, (counts.get(fileId) ?? 0) + 1);
    }
  }

  return {
    referencedFileIds: [...referenced].sort(),
    missingFileIds: [...referenced]
      .filter((fileId) => !counts.has(fileId))
      .sort(),
    duplicateFileIds: [...counts]
      .filter(([, count]) => count > 1)
      .map(([fileId]) => fileId)
      .sort(),
    unreferencedFileIds: [...counts]
      .filter(([fileId]) => !referenced.has(fileId))
      .map(([fileId]) => fileId)
      .sort(),
  };
}

function isInvisiblySmallElement(element: JsonObject): boolean {
  if (
    element.type === "line" ||
    element.type === "arrow" ||
    element.type === "freedraw"
  ) {
    return !Array.isArray(element.points) || element.points.length < 2;
  }
  return element.width === 0 && element.height === 0;
}

function objectOrEmpty(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
