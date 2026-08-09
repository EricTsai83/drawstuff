import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { clearLocalSceneStorage } from "@/data/local-storage";

type ClearCanvasForWorkspaceDeletionOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  cancelPendingSceneSave: () => void;
  clearCurrentScene: () => void;
  suppressDirtyTracking: () => void;
  resumeDirtyTracking: () => void;
  scheduleResume?: (callback: () => void) => void;
};

/**
 * Clears every in-memory and browser-persisted reference to a workspace that
 * has just been deleted. Dirty tracking stays suppressed across resetScene's
 * synchronous change event and resumes on the next frame.
 */
export function clearCanvasForWorkspaceDeletion({
  excalidrawAPI,
  cancelPendingSceneSave,
  clearCurrentScene,
  suppressDirtyTracking,
  resumeDirtyTracking,
  scheduleResume = (callback) => requestAnimationFrame(callback),
}: ClearCanvasForWorkspaceDeletionOptions): void {
  cancelPendingSceneSave();
  clearCurrentScene();
  suppressDirtyTracking();

  try {
    excalidrawAPI?.resetScene();
  } finally {
    clearLocalSceneStorage();
    scheduleResume(resumeDirtyTracking);
  }
}
