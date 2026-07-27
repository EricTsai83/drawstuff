import { STORAGE_KEYS } from "@/config/app-constants";
import {
  createPersistedWhiteboardDocumentV2,
  parseWhiteboardDocumentForImport,
  serializeWhiteboardDocumentV2,
  type WhiteboardDocument,
  type WhiteboardDocumentState,
  type WhiteboardDocumentV2,
  type WhiteboardAsset,
  type WhiteboardElement,
} from "@/features/whiteboard";

// SSR/Node 環境保護：只有在瀏覽器且存在 localStorage 才進行存取
function canUseLocalStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

function getDefaultAppState(): WhiteboardDocumentState {
  return {
    theme: "light",
    viewBackgroundColor: "#ffffff",
    gridSize: null,
    name: "",
  };
}

function clearAppStateForLocalStorage(
  appState: WhiteboardDocumentState,
): WhiteboardDocumentState {
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
  elements: WhiteboardElement[],
): WhiteboardElement[] {
  // 過濾掉 isDeleted 的元素
  return Array.isArray(elements) ? elements.filter((el) => !el.isDeleted) : [];
}

export const importFromLocalStorage = (options?: {
  readonly preferOwned?: boolean;
  readonly preferRecovery?: boolean;
}) => {
  if (!canUseLocalStorage()) {
    return {
      elements: [] as WhiteboardElement[],
      appState: null as WhiteboardDocumentState | null,
      files: {} as Readonly<Record<string, WhiteboardAsset>>,
      persistence: undefined as WhiteboardDocument["persistence"],
    };
  }
  let savedElements: string | null = null;
  let savedState: string | null = null;
  let savedFiles: string | null = null;
  let savedWhiteboardDocument: string | null = null;
  let savedRecoveryDocument: string | null = null;
  let legacyDocumentRevision = 0;
  let ownedDocumentRevision = 0;

  try {
    savedWhiteboardDocument = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
    );
    savedRecoveryDocument = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
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

  const preferredOwnedDocument = options?.preferRecovery
    ? (savedRecoveryDocument ?? savedWhiteboardDocument)
    : savedWhiteboardDocument;
  const loadedFromRecovery =
    options?.preferRecovery === true && savedRecoveryDocument !== null;
  const revisionAllowsOwnedDocument =
    ownedDocumentRevision > 0 &&
    ownedDocumentRevision >= legacyDocumentRevision;
  const shouldLoadOwnedDocument =
    options?.preferOwned !== false &&
    preferredOwnedDocument &&
    (options?.preferRecovery ? true : revisionAllowsOwnedDocument);
  if (shouldLoadOwnedDocument) {
    try {
      const document = parseWhiteboardDocumentForImport(preferredOwnedDocument);
      return {
        elements: clearElementsForLocalStorage([...document.elements]),
        appState: document.state,
        files: document.assets,
        persistence: document.persistence
          ? {
              ...document.persistence,
              ...(loadedFromRecovery ? { loadedFromRecovery: true } : {}),
            }
          : undefined,
      };
    } catch (error: unknown) {
      // Existing legacy keys remain a temporary conversion input. If the
      // canonical copy is corrupt, continue trying that pre-Phase-5J data.
      console.error("Failed to load owned local whiteboard document", error);
    }
  }

  if (savedElements !== null || savedState !== null || savedFiles !== null) {
    try {
      const document = parseWhiteboardDocumentForImport({
        type: "excalidraw",
        version: 2,
        elements: parseLocalStorageJson(savedElements, []),
        appState: parseLocalStorageJson(savedState, {}),
        files: parseLocalStorageJson(savedFiles, {}),
      });
      return {
        elements: clearElementsForLocalStorage([...document.elements]),
        appState: {
          ...getDefaultAppState(),
          ...clearAppStateForLocalStorage(document.state),
        },
        files: document.assets,
        persistence: document.persistence,
      };
    } catch (error: unknown) {
      console.error("Failed to load retained legacy whiteboard keys", error);
    }
  }

  return {
    elements: [] as WhiteboardElement[],
    appState: null as WhiteboardDocumentState | null,
    files: {} as Readonly<Record<string, WhiteboardAsset>>,
    persistence: undefined as WhiteboardDocument["persistence"],
  };
};

function parseLocalStorageJson(
  value: string | null,
  fallback: unknown,
): unknown {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    console.error(error);
    return fallback;
  }
}

/** Writes the active owned document without touching retained legacy keys. */
export function saveWhiteboardDocumentToLocalStorage(
  document: WhiteboardDocumentV2,
): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV2(document),
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
 * Owned sessions update only the canonical V2 key. Existing legacy keys remain
 * read-only conversion inputs until Phase 5L.
 */
export function saveOwnedWhiteboardDocumentToLocalStorage(
  document: WhiteboardDocument,
): boolean {
  const persistedDocument = createPersistedLocalWhiteboardDocument(document);
  if (!persistedDocument) return false;
  const saved = saveWhiteboardDocumentToLocalStorage(persistedDocument);
  if (!saved) return false;
  return document.persistence?.loadedFromRecovery === true
    ? clearOwnedRecoverySnapshot()
    : true;
}

function createPersistedLocalWhiteboardDocument(
  document: WhiteboardDocument,
): WhiteboardDocumentV2 | null {
  try {
    return createPersistedWhiteboardDocumentV2(document);
  } catch (error: unknown) {
    console.error("Failed to prepare owned local whiteboard document", error);
    return null;
  }
}

function clearOwnedRecoverySnapshot(): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.removeItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
    );
    return true;
  } catch (error: unknown) {
    console.error("Failed to clear consumed owned recovery snapshot", error);
    return false;
  }
}

export const getTotalStorageSize = () => {
  if (!canUseLocalStorage()) return 0;
  try {
    // 根據實際的 STORAGE_KEYS 配置計算
    const storageKeys = [
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, // "excalidraw"
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, // "excalidraw-state"
      STORAGE_KEYS.LOCAL_STORAGE_FILES, // "excalidraw-files"
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
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

    storageKeys.forEach((key) => {
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
