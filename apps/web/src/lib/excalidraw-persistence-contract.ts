import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

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

function objectOrEmpty(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
