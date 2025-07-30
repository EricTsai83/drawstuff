import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems_anyVersion,
} from "@excalidraw/excalidraw/types";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import { restore } from "@excalidraw/excalidraw";
import type { LegacyAppState } from "@excalidraw/excalidraw/data/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { importDataFromBackend } from "./import-data-from-db";

// 自定義類型定義
export interface ImportedDataState {
  type?: string;
  version?: number;
  source?: string;
  elements?: readonly ExcalidrawElement[] | null;
  appState?: Readonly<
    Partial<
      AppState & {
        [T in keyof LegacyAppState]: LegacyAppState[T][0];
      }
    >
  > | null;
  scrollToContent?: boolean;
  libraryItems?: LibraryItems_anyVersion;
  files?: BinaryFiles;
}

// 需要你自定義實現的函數
interface CustomImplementations {
  openConfirmModal: (dialog: {
    title: string;
    description: React.ReactNode;
    actionLabel: string;
    color: "danger" | "warning";
  }) => Promise<boolean>;

  importFromLocalStorage: () => {
    elements: any[];
    appState: any | null;
  };

  loadScene: (
    id: string | null,
    privateKey: string | null,
    localDataState: ImportedDataState | undefined | null,
  ) => Promise<RestoredDataState>;

  t: (key: string) => string;

  APP_NAME: string;
}

export const createInitializeScene = (
  implementations: CustomImplementations,
) => {
  const { openConfirmModal, importFromLocalStorage, loadScene, t, APP_NAME } =
    implementations;

  const shareableLinkConfirmDialog = {
    title: t("overwriteConfirm.modal.shareableLink.title"),
    description: t("overwriteConfirm.modal.shareableLink.description"),
    actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
    color: "danger" as const,
  };

  return async (opts: {
    excalidrawAPI: ExcalidrawImperativeAPI;
  }): Promise<
    { scene: ExcalidrawInitialDataState | null } & (
      | { isExternalScene: true; id: string; key: string }
      | { isExternalScene: false; id?: null; key?: null }
    )
  > => {
    const jsonBackendMatch = window.location.hash.match(
      /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
    );

    const localDataState = importFromLocalStorage();

    let scene: RestoredDataState & {
      scrollToContent?: boolean;
    } = await loadScene(null, null, localDataState);

    // 移除協作相關邏輯，只檢查 id 和 jsonBackendMatch
    const isExternalScene = !!jsonBackendMatch;

    if (isExternalScene) {
      if (
        // don't prompt if scene is empty
        !scene.elements.length ||
        // otherwise, prompt whether user wants to override current scene
        (await openConfirmModal(shareableLinkConfirmDialog))
      ) {
        if (jsonBackendMatch) {
          scene = await loadScene(
            jsonBackendMatch[1] ?? null, // scene id
            jsonBackendMatch[2] ?? null, // scene key
            localDataState,
          );
        }
        scene.scrollToContent = true;
        // 清除加密資訊，避免加密資訊一直存在在url 上
        window.history.replaceState({}, APP_NAME, window.location.origin);
      } else {
        // https://github.com/excalidraw/excalidraw/issues/1919
        if (document.hidden) {
          return new Promise((resolve, reject) => {
            window.addEventListener(
              "focus",
              () => {
                createInitializeScene(implementations)(opts)
                  .then(resolve)
                  .catch(reject);
              },
              {
                once: true,
              },
            );
          });
        }

        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    }

    if (scene) {
      return isExternalScene && jsonBackendMatch
        ? {
            scene,
            isExternalScene,
            id: jsonBackendMatch[1]!,
            key: jsonBackendMatch[2]!,
          }
        : { scene, isExternalScene: false };
    }
    return { scene: null, isExternalScene: false };
  };
};

export async function loadScene(
  id: string | null,
  privateKey: string | null,
  // Supply local state even if importing from backend to ensure we restore
  // localStorage user settings which we do not persist on server.
  // Non-optional so we don't forget to pass it even if `undefined`.
  localDataState: ImportedDataState | undefined | null,
) {
  let data;
  if (id != null && privateKey != null) {
    // the private key is used to decrypt the content from the server, take
    // extra care not to leak it
    data = restore(
      await importDataFromBackend(id, privateKey),
      localDataState?.appState,
      localDataState?.elements,
      { repairBindings: true, refreshDimensions: false },
    );
  } else {
    data = restore(localDataState ?? null, null, null, {
      repairBindings: true,
    });
  }

  return {
    elements: data.elements,
    appState: data.appState,
    // note: this will always be empty because we're not storing files
    // in the scene database/localStorage, and instead fetch them async
    // from a different database
    files: data.files,
  };
}
