import { type ReactNode } from "react";
// import type {
//   ExcalidrawImperativeAPI,
//   ExcalidrawInitialDataState,
// } from "@excalidraw/excalidraw/types";
// import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import { restore } from "@excalidraw/excalidraw";
import { importDataFromBackend } from "./import-data-from-db";
// import { importFromLocalStorage } from "@/data/local-storage";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";

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
