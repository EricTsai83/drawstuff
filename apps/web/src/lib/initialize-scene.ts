import { restoreScene } from "@drawstuff/excalidraw-adapter/client";
import { importDataFromBackend } from "./import-data-from-db";
import type { ImportedDataState } from "@drawstuff/excalidraw-adapter/types";

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
    data = restoreScene(
      await importDataFromBackend(id, privateKey),
      localDataState?.appState,
      localDataState?.elements,
      { repairBindings: true, refreshDimensions: false },
    );
  } else {
    data = restoreScene(localDataState ?? null, null, null, {
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

// 對話框文案由 OverwriteConfirmDialog 自己用 useAppI18n 以 key 翻譯（語言切換時
// 會跟著 re-render），因此這裡只負責「開啟並等待使用者決定」，不攜帶任何字串。
type OverwriteConfirmHandler = () => Promise<boolean>;

let overwriteConfirmHandler: OverwriteConfirmHandler | null = null;
const pendingOverwriteConfirmRequests: Array<(value: boolean) => void> = [];

export function setOverwriteConfirmHandler(
  handler: OverwriteConfirmHandler | null,
): void {
  overwriteConfirmHandler = handler;
  if (!handler) return;
  // flush pending requests if any
  while (pendingOverwriteConfirmRequests.length > 0) {
    const resolve = pendingOverwriteConfirmRequests.shift()!;
    handler()
      .then(resolve)
      .catch(() => resolve(false));
  }
}

export async function openConfirmModal() {
  return new Promise<boolean>((resolve) => {
    if (overwriteConfirmHandler) {
      overwriteConfirmHandler()
        .then(resolve)
        .catch(() => resolve(false));
      return;
    }
    // if handler not yet registered (e.g., early during initial render), queue it
    pendingOverwriteConfirmRequests.push(resolve);
  });
}
