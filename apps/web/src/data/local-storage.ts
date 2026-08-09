import type {
  AppState,
  BinaryFiles,
} from "@drawstuff/excalidraw-adapter/types";
import type { OrderedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import { releaseCanvasRoom } from "@/lib/collab/canvas-room-marker";

// ====== 自行實作 Excalidraw 狀態相關 helper ======

// SSR/Node 環境保護：只有在瀏覽器且存在 localStorage 才進行存取
function canUseLocalStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

const SCENE_SESSION_STORAGE_KEYS = [
  STORAGE_KEYS.CURRENT_SCENE_ID,
  STORAGE_KEYS.CURRENT_SCENE_REVISION,
  STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY,
  STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID,
] as const;

const LOCAL_SCENE_STORAGE_KEYS = [
  STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
  STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
  STORAGE_KEYS.LOCAL_STORAGE_FILES,
  STORAGE_KEYS.VERSION_DATA_STATE,
  STORAGE_KEYS.VERSION_FILES,
  ...SCENE_SESSION_STORAGE_KEYS,
] as const;

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

  try {
    savedElements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    savedState = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
    savedFiles = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES);
  } catch (error: unknown) {
    // Unable to access localStorage
    console.error(error);
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
    // Deliberately does NOT touch the collaboration canvas claim. Writing a scene
    // id is not the same event as replacing the canvas: a guest in a room has no
    // scene id at all, so its first cloud save arrives here with a brand-new id
    // while the canvas is unchanged. Releasing on that would silently stop the
    // guest's room sync mid-session. The claim is released where the canvas is
    // actually swapped — see `clearCurrentSceneSessionFromStorage` and
    // `use-apply-remote-scene.ts`.
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, id);
  } catch (error: unknown) {
    console.error(error);
  }
}

/** Clear all scene-session keys (ID + revision + dirty + workspaceId) at once. */
export function clearCurrentSceneSessionFromStorage(): void {
  if (!canUseLocalStorage()) return;
  try {
    // Starting a new scene, or leaving one, does replace (or repurpose) the
    // canvas, so the room's claim on it ends here — in the same synchronous block
    // as the storage write, which is what the session's `canSyncScene` reads.
    releaseCanvasRoom();
    for (const key of SCENE_SESSION_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch (error: unknown) {
    console.error(error);
  }
}

/**
 * Removes every browser-persisted value that can disclose or restore the
 * current canvas. User preferences and the separately user-scoped library are
 * deliberately preserved.
 */
export function clearLocalSceneStorage(): void {
  // The collaboration claim lives in sessionStorage and must be released even
  // when localStorage is unavailable.
  releaseCanvasRoom();
  if (!canUseLocalStorage()) return;
  try {
    for (const key of LOCAL_SCENE_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
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
