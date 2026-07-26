import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  createWhiteboardDocumentV1,
  filterReferencedWhiteboardAssets,
  parsePersistedWhiteboardPayload,
  serializeWhiteboardDocumentV1,
  toRuntimeWhiteboardDocument,
  type WhiteboardDocument,
  type WhiteboardDocumentV1,
} from "@/features/whiteboard";

// ====== 自行實作 Excalidraw 狀態相關 helper ======

// SSR/Node 環境保護：只有在瀏覽器且存在 localStorage 才進行存取
function canUseLocalStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

function getDefaultAppState(): Partial<AppState> {
  return {
    theme: "light",
    viewBackgroundColor: "#ffffff",
    gridSize: undefined,
    name: "", // 新增預設的 name 欄位
    // 可依需求補充預設值
  };
}

function clearAppStateForLocalStorage(
  appState: Partial<AppState>,
): Partial<AppState> {
  const { theme, viewBackgroundColor, gridSize, name, scrollX, scrollY, zoom } =
    appState;
  return {
    theme,
    viewBackgroundColor,
    gridSize,
    name,
    scrollX,
    scrollY,
    zoom,
  };
}

function clearElementsForLocalStorage(
  elements: OrderedExcalidrawElement[],
): OrderedExcalidrawElement[] {
  // 過濾掉 isDeleted 的元素
  return Array.isArray(elements) ? elements.filter((el) => !el.isDeleted) : [];
}

export const importFromLocalStorage = () => {
  if (!canUseLocalStorage()) {
    return {
      elements: [] as OrderedExcalidrawElement[],
      appState: null as Partial<AppState> | null,
      files: {} as BinaryFiles,
    };
  }
  let savedElements: string | null = null;
  let savedState: string | null = null;
  let savedFiles: string | null = null;
  let savedWhiteboardDocument: string | null = null;
  let legacyDocumentRevision = 0;
  let ownedDocumentRevision = 0;

  try {
    savedWhiteboardDocument = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
    );
    savedElements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    savedState = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
    savedFiles = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES);
    legacyDocumentRevision = loadDocumentRevision(
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
    );
    ownedDocumentRevision = loadDocumentRevision(
      STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
    );
  } catch (error: unknown) {
    // Unable to access localStorage
    console.error(error);
  }

  if (
    savedWhiteboardDocument &&
    ownedDocumentRevision > 0 &&
    ownedDocumentRevision >= legacyDocumentRevision
  ) {
    try {
      const persisted = parsePersistedWhiteboardPayload(
        savedWhiteboardDocument,
      );
      if (persisted.format === "whiteboard-v1") {
        const document = toRuntimeWhiteboardDocument(persisted.document);
        return {
          elements: clearElementsForLocalStorage(
            document.elements as unknown as OrderedExcalidrawElement[],
          ),
          appState: document.state as unknown as Partial<AppState>,
          files: document.assets as unknown as BinaryFiles,
        };
      }
    } catch (error: unknown) {
      // The legacy keys are deliberately retained as a rollback copy. If an
      // opt-in owned document is corrupt, continue loading that snapshot.
      console.error("Failed to load owned local whiteboard document", error);
    }
  }

  let elements: OrderedExcalidrawElement[] = [];
  if (savedElements) {
    try {
      elements = clearElementsForLocalStorage(
        JSON.parse(savedElements) as OrderedExcalidrawElement[],
      );
    } catch (error: unknown) {
      console.error(error);
      // Do nothing because elements array is already empty
    }
  }

  let appState: Partial<AppState> | null = null;
  if (savedState) {
    try {
      appState = {
        ...getDefaultAppState(),
        ...clearAppStateForLocalStorage(
          JSON.parse(savedState) as Partial<AppState>,
        ),
      };
    } catch (error: unknown) {
      console.error(error);
      // Do nothing because appState is already null
    }
  }

  let files: BinaryFiles = {};
  if (savedFiles) {
    try {
      files = JSON.parse(savedFiles) as BinaryFiles;
    } catch (error: unknown) {
      console.error(error);
      // Do nothing because files is already empty object
    }
  }

  return { elements, appState, files };
};

/**
 * Opt-in Phase 5B write path. Legacy localStorage keys are intentionally left
 * untouched so disabling owned-format reads restores the last legacy snapshot.
 */
export function saveWhiteboardDocumentToLocalStorage(
  document: WhiteboardDocumentV1,
): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV1(document),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
      nextDocumentRevision().toString(),
    );
    return true;
  } catch (error: unknown) {
    console.error("Failed to save owned local whiteboard document", error);
    return false;
  }
}

/**
 * Once an owned snapshot has been opted into, keep it current alongside the
 * retained legacy keys. The original rollback envelope is never replaced.
 */
export function syncOwnedWhiteboardDocumentToLocalStorage(
  document: WhiteboardDocument,
): boolean {
  if (!canUseLocalStorage()) return false;
  const revision = nextDocumentRevision();
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      revision.toString(),
    );
    const source = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
    );
    if (!source) return true;

    const persisted = parsePersistedWhiteboardPayload(source);
    if (persisted.format !== "whiteboard-v1") return true;
    const currentMetadata = persisted.document.metadata;
    const nextDocument = createWhiteboardDocumentV1({
      elements: document.elements,
      assets: filterReferencedWhiteboardAssets(
        document.elements,
        document.assets,
      ),
      metadata: {
        name:
          typeof document.state.name === "string"
            ? document.state.name
            : currentMetadata.name,
        theme:
          document.state.theme === "light" || document.state.theme === "dark"
            ? document.state.theme
            : currentMetadata.theme,
        viewBackgroundColor:
          typeof document.state.viewBackgroundColor === "string"
            ? document.state.viewBackgroundColor
            : currentMetadata.viewBackgroundColor,
        gridSize:
          typeof document.state.gridSize === "number" &&
          Number.isFinite(document.state.gridSize)
            ? document.state.gridSize
            : null,
        ...(currentMetadata.legacy ? { legacy: currentMetadata.legacy } : {}),
      },
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV1(nextDocument),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
      revision.toString(),
    );
    return true;
  } catch (error: unknown) {
    // Legacy keys were already written by the caller and remain recoverable.
    console.error("Failed to sync owned local whiteboard document", error);
    try {
      localStorage.removeItem(
        STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
      );
    } catch {
      // Storage itself is unavailable; the next readable load still retains
      // all legacy keys written before this sync attempt.
    }
    return false;
  }
}

export const getElementsStorageSize = () => {
  if (!canUseLocalStorage()) return 0;
  try {
    const elements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    const elementsSize = elements?.length ?? 0;
    return elementsSize;
  } catch (error: unknown) {
    console.error(error);
    return 0;
  }
};

export const getTotalStorageSize = () => {
  if (!canUseLocalStorage()) return 0;
  try {
    // 根據實際的 STORAGE_KEYS 配置計算
    const excalidrawKeys = [
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, // "excalidraw"
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, // "excalidraw-state"
      STORAGE_KEYS.LOCAL_STORAGE_FILES, // "excalidraw-files"
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
      STORAGE_KEYS.LOCAL_STORAGE_THEME, // "theme"
      STORAGE_KEYS.VERSION_DATA_STATE, // "version-dataState"
      STORAGE_KEYS.VERSION_FILES, // "version-files"
      STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, // "i18nextLng"
      STORAGE_KEYS.IDB_LIBRARY, // "excalidraw-library"
      STORAGE_KEYS.CURRENT_SCENE_ID,
      STORAGE_KEYS.CURRENT_SCENE_REVISION,
      STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY,
      STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID,
    ];

    let totalSize = 0;

    excalidrawKeys.forEach((key) => {
      const value = localStorage.getItem(key);
      if (value) {
        // 使用 UTF-16 編碼計算（每字符 2 字節）
        const itemSize = (key.length + value.length) * 2;
        totalSize += itemSize;
      }
    });

    return totalSize;
  } catch (error: unknown) {
    console.error(error);
    return 0;
  }
};

function loadDocumentRevision(
  key:
    | typeof STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION
    | typeof STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
): number {
  if (!canUseLocalStorage()) return 0;
  const value = Number(localStorage.getItem(key));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nextDocumentRevision(): number {
  return Math.max(
    Date.now(),
    loadDocumentRevision(STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION) +
      1,
    loadDocumentRevision(STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION) +
      1,
  );
}

// ====== Scene ID helpers (local-first) ======

export function loadCurrentSceneIdFromStorage(): string | undefined {
  if (!canUseLocalStorage()) return undefined;
  try {
    const id = localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_ID);
    return id ?? undefined;
  } catch (error: unknown) {
    console.error(error);
    return undefined;
  }
}

export function saveCurrentSceneIdToStorage(id: string): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, id);
  } catch (error: unknown) {
    console.error(error);
  }
}

export function clearCurrentSceneIdFromStorage(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_ID);
  } catch (error: unknown) {
    console.error(error);
  }
}

/** Clear all scene-session keys (ID + revision + dirty + workspaceId) at once. */
export function clearCurrentSceneSessionFromStorage(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_ID);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_REVISION);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID);
  } catch (error: unknown) {
    console.error(error);
  }
}

export function loadCurrentSceneRevisionFromStorage(): number | undefined {
  if (!canUseLocalStorage()) return undefined;
  try {
    const rawRevision = localStorage.getItem(
      STORAGE_KEYS.CURRENT_SCENE_REVISION,
    );
    if (!rawRevision) return undefined;
    const revision = Number(rawRevision);
    return Number.isInteger(revision) && revision > 0 ? revision : undefined;
  } catch (error: unknown) {
    console.error(error);
    return undefined;
  }
}

export function saveCurrentSceneRevisionToStorage(revision: number): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(
      STORAGE_KEYS.CURRENT_SCENE_REVISION,
      revision.toString(),
    );
  } catch (error: unknown) {
    console.error(error);
  }
}

export function clearCurrentSceneRevisionFromStorage(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_REVISION);
  } catch (error: unknown) {
    console.error(error);
  }
}

export function loadCurrentSceneDirtyFromStorage(): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    return localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY) === "true";
  } catch (error: unknown) {
    console.error(error);
    return false;
  }
}

export function saveCurrentSceneDirtyToStorage(isDirty: boolean): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(
      STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY,
      isDirty ? "true" : "false",
    );
  } catch (error: unknown) {
    console.error(error);
  }
}

export function clearCurrentSceneDirtyFromStorage(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY);
  } catch (error: unknown) {
    console.error(error);
  }
}

// ====== Scene Workspace ID helpers ======

export function loadCurrentSceneWorkspaceIdFromStorage(): string | undefined {
  if (!canUseLocalStorage()) return undefined;
  try {
    const id = localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID);
    return id ?? undefined;
  } catch (error: unknown) {
    console.error(error);
    return undefined;
  }
}

export function saveCurrentSceneWorkspaceIdToStorage(id: string): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID, id);
  } catch (error: unknown) {
    console.error(error);
  }
}

export function clearCurrentSceneWorkspaceIdFromStorage(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID);
  } catch (error: unknown) {
    console.error(error);
  }
}
