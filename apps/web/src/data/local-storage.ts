import { STORAGE_KEYS } from "@/config/app-constants";
import {
  createPersistedWhiteboardDocumentV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
  type OwnedWhiteboardDocument,
  type WhiteboardDocumentState,
  type WhiteboardDocumentV2,
  type WhiteboardAsset,
  type WhiteboardElement,
} from "@drawstuff/whiteboard";

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

export const importFromLocalStorage = () => {
  if (!canUseLocalStorage()) {
    return {
      elements: [] as WhiteboardElement[],
      appState: null as WhiteboardDocumentState | null,
      files: {} satisfies Readonly<Record<string, WhiteboardAsset>>,
    };
  }
  try {
    const source = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
    );
    if (source !== null) {
      const document = toRuntimeWhiteboardDocumentV2(
        parseWhiteboardDocumentV2(source),
      );
      return {
        elements: clearElementsForLocalStorage([...document.elements]),
        appState: document.state,
        files: document.assets,
      };
    }
  } catch (error: unknown) {
    console.error("Failed to load local whiteboard document", error);
  }

  return {
    elements: [] as WhiteboardElement[],
    appState: null as WhiteboardDocumentState | null,
    files: {} satisfies Readonly<Record<string, WhiteboardAsset>>,
  };
};

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
  document: OwnedWhiteboardDocument,
): boolean {
  const persistedDocument = createPersistedLocalWhiteboardDocument(document);
  if (!persistedDocument) return false;
  return saveWhiteboardDocumentToLocalStorage(persistedDocument);
}

function createPersistedLocalWhiteboardDocument(
  document: OwnedWhiteboardDocument,
): WhiteboardDocumentV2 | null {
  try {
    return createPersistedWhiteboardDocumentV2(document);
  } catch (error: unknown) {
    console.error("Failed to prepare owned local whiteboard document", error);
    return null;
  }
}

export const getTotalStorageSize = () => {
  if (!canUseLocalStorage()) return 0;
  try {
    // 根據實際的 STORAGE_KEYS 配置計算
    const storageKeys = [
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      STORAGE_KEYS.LOCAL_STORAGE_THEME, // "theme"
      STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, // "i18nextLng"
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
