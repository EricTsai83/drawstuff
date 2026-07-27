import { STORAGE_KEYS } from "@/config/app-constants";
import {
  createPersistedWhiteboardDocumentV2,
  convertPersistedWhiteboardDocumentToV2,
  parseWhiteboardDocumentV2,
  recordWhiteboardDiagnostic,
  serializeWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
  WHITEBOARD_DOCUMENT_VERSION,
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

function clearElementsForLocalStorage(
  elements: WhiteboardElement[],
): WhiteboardElement[] {
  // 過濾掉 isDeleted 的元素
  return Array.isArray(elements) ? elements.filter((el) => !el.isDeleted) : [];
}

let localConvergenceFailureRecorded = false;

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
  try {
    const converged = convergeLocalWhiteboardStorage(options);
    if (converged) {
      const document = toRuntimeWhiteboardDocumentV2(converged.document);
      return {
        elements: clearElementsForLocalStorage([...document.elements]),
        appState: document.state,
        files: document.assets,
        persistence: converged.loadedFromRecovery
          ? { ...document.persistence!, loadedFromRecovery: true }
          : document.persistence,
      };
    }
  } catch (error: unknown) {
    console.error("Failed to converge local whiteboard storage", error);
  }

  return {
    elements: [] as WhiteboardElement[],
    appState: null as WhiteboardDocumentState | null,
    files: {} as Readonly<Record<string, WhiteboardAsset>>,
    persistence: undefined as WhiteboardDocument["persistence"],
  };
};

/**
 * Phase 5K support-window conversion. A canonical write is parsed back and
 * compared byte-for-byte before obsolete keys are removed.
 */
function convergeLocalWhiteboardStorage(options?: {
  readonly preferOwned?: boolean;
  readonly preferRecovery?: boolean;
}): {
  readonly document: WhiteboardDocumentV2;
  readonly loadedFromRecovery?: true;
} | null {
  const canonicalSource = localStorage.getItem(
    STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
  );
  const recoverySource = localStorage.getItem(
    STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
  );
  const hasLegacyKeys = [
    STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
    STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
    STORAGE_KEYS.LOCAL_STORAGE_FILES,
  ].some((key) => localStorage.getItem(key) !== null);
  const hasObsoleteKeys =
    hasLegacyKeys ||
    [
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
      STORAGE_KEYS.VERSION_DATA_STATE,
      STORAGE_KEYS.VERSION_FILES,
    ].some((key) => localStorage.getItem(key) !== null);

  if (options?.preferRecovery && recoverySource !== null) {
    try {
      return {
        document:
          convertPersistedWhiteboardDocumentToV2(recoverySource).document,
        loadedFromRecovery: true,
      };
    } catch (error: unknown) {
      console.error("Failed to convert local recovery snapshot", error);
      recordLocalConvergence("failure");
    }
  }

  if (options?.preferOwned === false && hasLegacyKeys) {
    try {
      const source = readLegacyLocalWhiteboardSource();
      return source
        ? {
            document: convertPersistedWhiteboardDocumentToV2(source).document,
          }
        : null;
    } catch (error: unknown) {
      console.error("Failed to convert retained local whiteboard keys", error);
      recordLocalConvergence("failure");
    }
  }

  if (canonicalSource !== null) {
    try {
      const canonical = parseWhiteboardDocumentV2(canonicalSource);
      finishLocalConvergence(canonical, {
        hasLegacyKeys,
        hasObsoleteKeys,
      });
      return { document: canonical };
    } catch {
      try {
        const converted =
          convertPersistedWhiteboardDocumentToV2(canonicalSource).document;
        const verified = writeAndVerifyLocalDocument(converted);
        finishLocalConvergence(verified, {
          hasLegacyKeys,
          hasObsoleteKeys,
          recordSuccess: true,
        });
        return { document: verified };
      } catch (error: unknown) {
        console.error("Failed to convert canonical local document", error);
      }
    }
  }

  if (hasLegacyKeys) {
    try {
      const source = readLegacyLocalWhiteboardSource();
      if (source !== null) {
        const converted =
          convertPersistedWhiteboardDocumentToV2(source).document;
        const verified = writeAndVerifyLocalDocument(converted);
        finishLocalConvergence(verified, {
          hasLegacyKeys,
          hasObsoleteKeys,
          legacyKeysAlreadyVerified: true,
          recordSuccess: true,
        });
        return { document: verified };
      }
    } catch (error: unknown) {
      console.error("Failed to convert retained local whiteboard keys", error);
    }
  }

  if (canonicalSource !== null || hasLegacyKeys) {
    recordLocalConvergence("failure");
  }
  return null;
}

function writeAndVerifyLocalDocument(
  document: WhiteboardDocumentV2,
): WhiteboardDocumentV2 {
  const serialized = serializeWhiteboardDocumentV2(document);
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
    serialized,
  );
  const verified = parseWhiteboardDocumentV2(
    localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
  );
  if (serializeWhiteboardDocumentV2(verified) !== serialized) {
    throw new Error("Local V2 verification did not match the written data");
  }
  return verified;
}

function finishLocalConvergence(
  document: WhiteboardDocumentV2,
  options: {
    readonly hasLegacyKeys: boolean;
    readonly hasObsoleteKeys: boolean;
    readonly legacyKeysAlreadyVerified?: boolean;
    readonly recordSuccess?: boolean;
  },
): void {
  if (!options.hasObsoleteKeys && !options.recordSuccess) return;
  try {
    parseWhiteboardDocumentV2(document);
    if (options.hasLegacyKeys && !options.legacyKeysAlreadyVerified) {
      const legacySource = readLegacyLocalWhiteboardSource();
      if (legacySource !== null) {
        convertPersistedWhiteboardDocumentToV2(legacySource);
      }
    }
  } catch (error: unknown) {
    console.error(
      "Obsolete local whiteboard keys are not safe to remove",
      error,
    );
    recordLocalConvergence("failure");
    return;
  }
  recordLocalConvergence(
    removeObsoleteLocalWhiteboardKeys() ? "success" : "failure",
  );
}

function readLegacyLocalWhiteboardSource(): string | null {
  const elements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
  const state = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
  const files = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES);
  if (elements === null && state === null && files === null) return null;
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: parseLocalStorageJson(elements, []),
    appState: parseLocalStorageJson(state, {}),
    files: parseLocalStorageJson(files, {}),
  });
}

function removeObsoleteLocalWhiteboardKeys(): boolean {
  try {
    for (const key of [
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      STORAGE_KEYS.LOCAL_STORAGE_FILES,
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION,
      STORAGE_KEYS.VERSION_DATA_STATE,
      STORAGE_KEYS.VERSION_FILES,
    ]) {
      localStorage.removeItem(key);
    }
    return true;
  } catch (error: unknown) {
    console.error("Failed to remove obsolete local whiteboard keys", error);
    return false;
  }
}

function recordLocalConvergence(outcome: "failure" | "success"): void {
  if (outcome === "failure") {
    if (localConvergenceFailureRecorded) return;
    localConvergenceFailureRecorded = true;
  }
  recordWhiteboardDiagnostic({
    operation: "migration",
    outcome,
    engine: "owned",
    documentVersion: outcome === "success" ? WHITEBOARD_DOCUMENT_VERSION : null,
    ...(outcome === "failure" ? { errorCode: "INVALID_DOCUMENT" } : {}),
  });
}

function parseLocalStorageJson(
  value: string | null,
  fallback: unknown,
): unknown {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Retained local whiteboard JSON is invalid", {
      cause: error,
    });
  }
}

/** Writes the active canonical V2 document. */
export function saveWhiteboardDocumentToLocalStorage(
  document: WhiteboardDocumentV2,
): boolean {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV2(document),
    );
    return true;
  } catch (error: unknown) {
    console.error("Failed to save owned local whiteboard document", error);
    return false;
  }
}

/**
 * Owned sessions update only the canonical V2 key.
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
    console.error("Failed to clear consumed local recovery snapshot", error);
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
