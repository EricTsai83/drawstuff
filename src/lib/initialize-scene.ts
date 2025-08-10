import { type ReactNode } from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import { restore } from "@excalidraw/excalidraw";
import { importDataFromBackend } from "./import-data-from-db";
import { importFromLocalStorage } from "@/data/local-storage";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";

// 需要你自定義實現的函數

export function InitializeScene(t: (key: string) => string) {
  const shareableLinkConfirmDialog = {
    title: t("overwriteConfirm.modal.shareableLink.title"),
    description: t("overwriteConfirm.modal.shareableLink.description"),
    actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
  };

  return async (opts: {
    excalidrawAPI: ExcalidrawImperativeAPI;
  }): Promise<
    { scene: ExcalidrawInitialDataState | null } & (
      | { isExternalScene: true; id: string; key: string }
      | { isExternalScene: false; id?: null; key?: null }
    )
  > => {
    // 第一部分是 scene id，第二部分是 scene hash key
    const jsonBackendMatch = /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/.exec(
      window.location.hash,
    );

    const localDataState = importFromLocalStorage();

    let scene: RestoredDataState & {
      scrollToContent?: boolean;
    } = await loadScene(undefined, undefined, localDataState);

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
            jsonBackendMatch[1], // scene id
            jsonBackendMatch[2], // scene key
            localDataState,
          );
        }
        scene.scrollToContent = true;
        // 清除加密資訊，避免加密資訊一直存在在url 上
        window.history.replaceState(
          {},
          "我先隨便取的APP_NAME",
          window.location.origin,
        );
      } else {
        // https://github.com/excalidraw/excalidraw/issues/1919
        if (document.hidden) {
          return new Promise((resolve, reject) => {
            window.addEventListener(
              "focus",
              () => {
                InitializeScene(t)(opts).then(resolve).catch(reject);
              },
              {
                once: true,
              },
            );
          });
        }

        window.history.replaceState(
          {},
          "我先隨便取的APP_NAME",
          window.location.origin,
        );
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
}

export async function loadScene(
  id: string | undefined,
  privateKey: string | undefined,
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

export type OverwriteConfirmRequest = {
  title: string;
  description: ReactNode;
  actionLabel: string;
};

type OverwriteConfirmHandler = (
  request: OverwriteConfirmRequest,
) => Promise<boolean>;

let overwriteConfirmHandler: OverwriteConfirmHandler | null = null;
const pendingOverwriteConfirmRequests: Array<{
  request: OverwriteConfirmRequest;
  resolve: (value: boolean) => void;
}> = [];

export function setOverwriteConfirmHandler(
  handler: OverwriteConfirmHandler | null,
): void {
  overwriteConfirmHandler = handler;
  if (!handler) return;
  // flush pending requests if any
  while (pendingOverwriteConfirmRequests.length > 0) {
    const { request, resolve } = pendingOverwriteConfirmRequests.shift()!;
    handler(request)
      .then(resolve)
      .catch(() => resolve(false));
  }
}

export async function openConfirmModal(request: OverwriteConfirmRequest) {
  return new Promise<boolean>((resolve) => {
    if (overwriteConfirmHandler) {
      overwriteConfirmHandler(request)
        .then(resolve)
        .catch(() => resolve(false));
      return;
    }
    // if handler not yet registered (e.g., early during initial render), queue it
    pendingOverwriteConfirmRequests.push({ request, resolve });
  });
}
