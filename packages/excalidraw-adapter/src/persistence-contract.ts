import type { AppState, BinaryFiles, ExcalidrawElement } from "./types.ts";

export const EXCALIDRAW_PERSISTENCE_CONTRACT = {
  upstreamFormatVersion: 2,
} as const;

export const OFFICIAL_SERVER_APP_STATE_KEYS = [
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "viewBackgroundColor",
] as const satisfies readonly (keyof AppState)[];

export type ExcalidrawStorageProfile =
  "owned-scene" | "readonly-share" | "local-export";

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

/**
 * Ids of the binary assets a set of elements still references, deduplicated.
 *
 * Reads elements opaquely, like the rest of this module: the caller may hand over
 * engine elements, protocol elements, or a stored document's array, and the answer
 * only depends on `fileId` and `isDeleted`. A deleted element references nothing —
 * its image must not be fetched or kept alive by a tombstone.
 */
export function collectReferencedFileIds(
  elements: readonly ExcalidrawElement[] | readonly unknown[],
): string[] {
  const fileIds = new Set<string>();
  for (const element of elements) {
    const value = objectOrEmpty(element);
    const fileId = value.fileId;
    if (!value.isDeleted && typeof fileId === "string" && fileId.length > 0) {
      fileIds.add(fileId);
    }
  }
  return [...fileIds];
}

export function filterReferencedFiles(
  elements: readonly ExcalidrawElement[] | readonly unknown[],
  files: BinaryFiles,
): BinaryFiles {
  const referencedFiles: BinaryFiles = {};
  for (const fileId of collectReferencedFileIds(elements)) {
    const file = files[fileId];
    if (file) referencedFiles[fileId] = file;
  }
  return referencedFiles;
}

function objectOrEmpty(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
