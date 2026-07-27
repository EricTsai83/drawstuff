import {
  clearCurrentSceneRevisionFromStorage,
  clearCurrentSceneSessionFromStorage,
  importFromLocalStorage,
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneDirtyToStorage,
  saveCurrentSceneIdToStorage,
  saveCurrentSceneRevisionToStorage,
} from "@/data/local-storage";
import {
  filterReferencedWhiteboardAssets,
  type WhiteboardAsset,
  type OwnedWhiteboardDocument,
  type WhiteboardDocumentState,
  type WhiteboardElement,
  type WhiteboardEngine,
} from "@drawstuff/whiteboard";
import { openConfirmModal } from "@/lib/initialize-scene";
import { parseSharedSceneHash } from "@/lib/utils";
import { exportOwnedWhiteboardImage } from "@drawstuff/whiteboard";

export type InitialWhiteboardDocument = OwnedWhiteboardDocument & {
  readonly scrollToContent?: boolean;
};

type InitialDocumentFailureCode = "INVALID_DOCUMENT" | "NETWORK" | "UNKNOWN";

export async function createInitialWhiteboardDocument(options?: {
  readonly onFailure?: (errorCode: InitialDocumentFailureCode) => void;
}): Promise<InitialWhiteboardDocument | null> {
  try {
    const localDocument = readLocalDocument();
    const sharedScene = parseSharedSceneHash();

    if (sharedScene) {
      try {
        if (
          hasDocumentContent(localDocument) &&
          !(await openConfirmModal({
            title: "載入分享連結內容？",
            description: "此操作將覆蓋目前畫布內容。",
            actionLabel: "覆蓋並載入",
          }))
        ) {
          clearSharedSceneHash();
          return localDocument;
        }

        const { importDataFromBackend } =
          await import("@/lib/import-data-from-db");
        const document = await importDataFromBackend(
          sharedScene.id,
          sharedScene.key,
        );
        clearSharedSceneHash();
        return document ? withInitialState(document, true) : localDocument;
      } catch (error) {
        console.error("透過 URL 載入場景失敗，回退至本地資料:", error);
        options?.onFailure?.("NETWORK");
        return localDocument;
      }
    }

    if (hasDocumentContent(localDocument)) return localDocument;
    return await loadInitialRemoteDocument(options?.onFailure);
  } catch (error) {
    console.error("初始化場景失敗:", error);
    options?.onFailure?.("UNKNOWN");
    return null;
  }
}

function readLocalDocument(): InitialWhiteboardDocument {
  const local = importFromLocalStorage();
  const state = ensureInitialWhiteboardState(local.appState ?? {});
  return {
    elements: local.elements,
    state,
    assets: local.files,
    scrollToContent: !hasViewportData(state),
  };
}

async function loadInitialRemoteDocument(
  onFailure?: (errorCode: InitialDocumentFailureCode) => void,
): Promise<InitialWhiteboardDocument | null> {
  const sceneId = loadCurrentSceneIdFromStorage();
  if (!sceneId) return null;

  try {
    const { importSceneDataBySceneId, importSceneFilesBySceneId } =
      await import("@/lib/import-data-from-db");
    const [imported, externalAssets] = await Promise.all([
      importSceneDataBySceneId(sceneId),
      importSceneFilesBySceneId(sceneId),
    ]);
    if (!imported.document) {
      clearCurrentSceneSessionFromStorage();
      return null;
    }

    const document = withInitialState(
      {
        ...imported.document,
        assets: {
          ...imported.document.assets,
          ...externalAssets,
        },
      },
      false,
    );
    saveCurrentSceneIdToStorage(sceneId);
    saveCurrentSceneDirtyToStorage(false);
    if (imported.revision !== undefined) {
      saveCurrentSceneRevisionToStorage(imported.revision);
    } else {
      clearCurrentSceneRevisionFromStorage();
    }
    return document;
  } catch (error) {
    console.error("初始化遠端場景失敗:", error);
    onFailure?.("NETWORK");
    clearCurrentSceneSessionFromStorage();
    return null;
  }
}

function withInitialState(
  document: OwnedWhiteboardDocument,
  scrollToContent: boolean,
): InitialWhiteboardDocument {
  const state = ensureInitialWhiteboardState(document.state);
  return {
    ...document,
    state,
    scrollToContent: scrollToContent || !hasViewportData(state),
  };
}

function hasDocumentContent(
  document: OwnedWhiteboardDocument | null,
): document is OwnedWhiteboardDocument {
  return Boolean(
    document &&
    (document.elements.length > 0 ||
      Object.keys(document.assets).length > 0 ||
      document.state.name),
  );
}

function clearSharedSceneHash(): void {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, document.title, window.location.origin);
}

export function cleanUnusedWhiteboardAssets(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): Readonly<Record<string, WhiteboardAsset>> {
  return filterReferencedWhiteboardAssets(
    elements.filter((element) => !element.isDeleted),
    assets,
  );
}

export function getReferencedAssetIds(
  elements: readonly WhiteboardElement[] | null | undefined,
): Set<string> {
  const assetIds = new Set<string>();
  if (!elements) return assetIds;
  for (const element of elements) {
    if (!element.isDeleted && isInitializedImageElement(element)) {
      assetIds.add(element.fileId);
    }
  }
  return assetIds;
}

export function hasCompleteSceneAssetHydration(
  elements: readonly WhiteboardElement[] | null | undefined,
  assets: Readonly<Record<string, WhiteboardAsset>> | null | undefined,
): boolean {
  const referencedAssetIds = getReferencedAssetIds(elements);
  return (
    referencedAssetIds.size === 0 ||
    Boolean(
      assets &&
      [...referencedAssetIds].every((assetId) => Boolean(assets[assetId])),
    )
  );
}

export function clearElementsForDatabase(
  elements: readonly WhiteboardElement[],
): WhiteboardElement[] {
  return elements.filter((element) => !element.isDeleted);
}

export function isInitializedImageElement(
  element: WhiteboardElement | null | undefined,
): element is WhiteboardElement & { readonly fileId: string } {
  return element?.type === "image" && typeof element.fileId === "string";
}

export function getCurrentSceneSnapshot(
  engine?: WhiteboardEngine | null,
): OwnedWhiteboardDocument | null {
  if (!engine) return null;
  const document = engine.getDocument();
  const elements = document.elements.filter((element) => !element.isDeleted);
  return {
    ...document,
    elements,
    assets: cleanUnusedWhiteboardAssets(elements, document.assets),
  };
}

export function ensureInitialWhiteboardState(
  state: WhiteboardDocumentState,
): WhiteboardDocumentState {
  const scrollX = finiteNumber(state.scrollX);
  const scrollY = finiteNumber(state.scrollY);
  const zoom =
    typeof state.zoom?.value === "number" && Number.isFinite(state.zoom.value)
      ? { value: state.zoom.value }
      : undefined;
  return {
    theme: state.theme,
    viewBackgroundColor: state.viewBackgroundColor,
    gridSize: state.gridSize,
    name: state.name,
    ...(scrollX === undefined ? {} : { scrollX }),
    ...(scrollY === undefined ? {} : { scrollY }),
    ...(zoom ? { zoom } : {}),
  };
}

export async function exportSceneThumbnail(
  elements: readonly WhiteboardElement[],
  state: WhiteboardDocumentState,
  assets: Readonly<Record<string, WhiteboardAsset>>,
  options?: {
    readonly maxSize?: number;
    readonly padding?: number;
    readonly quality?: number;
  },
): Promise<Blob> {
  return await exportOwnedWhiteboardImage(
    { elements, state, assets },
    {
      format: "png",
      maxWidthOrHeight: options?.maxSize ?? 800,
      exportPadding: options?.padding ?? 12,
      quality: options?.quality ?? 1,
      background: true,
    },
  );
}

function hasViewportData(state: WhiteboardDocumentState): boolean {
  return (
    typeof state.scrollX === "number" ||
    typeof state.scrollY === "number" ||
    state.zoom !== undefined
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
