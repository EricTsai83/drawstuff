import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { pauseLocalScenePersistence } from "@/data/local-scene-persistence";
import { clearLocalSceneStorage } from "@/data/local-storage";

type ClearCanvasForSignOutOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  cancelPendingSceneSave: () => void;
  clearCurrentScene: () => void;
  suppressDirtyTracking: () => void;
};

/**
 * Clears both the visible canvas and every browser-persisted copy after the
 * server has accepted sign-out. The lock intentionally remains held until the
 * hard navigation releases this JavaScript realm.
 */
export function clearCanvasForSignOut({
  excalidrawAPI,
  cancelPendingSceneSave,
  clearCurrentScene,
  suppressDirtyTracking,
}: ClearCanvasForSignOutOptions): void {
  pauseLocalScenePersistence("sign-out");
  cancelPendingSceneSave();

  try {
    clearCurrentScene();
    // Hold dirty tracking across resetScene's synchronous change event. The
    // hold is never resumed here on purpose: the hard navigation below leaves
    // this realm, and the safety net covers the window until it does.
    suppressDirtyTracking();
    excalidrawAPI?.resetScene();
  } finally {
    // Storage cleanup is the privacy boundary and must run even if the canvas
    // engine fails while resetting its in-memory state.
    clearLocalSceneStorage();
  }
}
