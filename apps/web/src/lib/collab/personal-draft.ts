import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import type { SceneIdentity } from "@/hooks/scene-session-context";
import { STORAGE_KEYS } from "@/config/app-constants";
import { importFromLocalStorage } from "@/data/local-storage";
import {
  isSigningOut,
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";
import { releaseCanvasRoom } from "@/lib/collab/canvas-room-marker";
import { saveToLocalStorage } from "@/lib/excalidraw";

// Contains only the personal canvas captured BEFORE the room takes ownership.
// Per-tab storage preserves that canvas across reloads and other tabs' saves.
const DRAFT_KEY = STORAGE_KEYS.PERSONAL_DRAFT_BEFORE_ROOM;
const SESSION_KEYS = [
  STORAGE_KEYS.CURRENT_SCENE_ID,
  STORAGE_KEYS.CURRENT_SCENE_REVISION,
  STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY,
  STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID,
] as const;
type PersonalDraft = {
  canvas: ReturnType<typeof importFromLocalStorage>;
  session: Record<string, string | null>;
};

export function preserveCachedPersonalDraft(): void {
  if (sessionStorage.getItem(DRAFT_KEY)) return;
  sessionStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      canvas: importFromLocalStorage(),
      session: Object.fromEntries(
        SESSION_KEYS.map((key) => [key, localStorage.getItem(key)]),
      ),
    } satisfies PersonalDraft),
  );
}

export function preservePersonalDraft(
  api: ExcalidrawImperativeAPI,
  cancelPendingSave: () => void,
  identity?: SceneIdentity,
): void {
  if (!sessionStorage.getItem(DRAFT_KEY)) {
    const canvas = {
      elements: [...api.getSceneElementsIncludingDeleted()],
      appState: (() => {
        const {
          name,
          theme,
          viewBackgroundColor,
          gridSize,
          scrollX,
          scrollY,
          zoom,
        } = api.getAppState();
        return {
          name,
          theme,
          viewBackgroundColor,
          gridSize,
          scrollX,
          scrollY,
          zoom,
        };
      })(),
      files: api.getFiles(),
    };
    // Fail before touching the canvas if storage is unavailable or full.
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        canvas,
        session: identity
          ? {
              [STORAGE_KEYS.CURRENT_SCENE_ID]: identity.id ?? null,
              [STORAGE_KEYS.CURRENT_SCENE_REVISION]:
                identity.revision === undefined
                  ? null
                  : String(identity.revision),
              [STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID]:
                identity.workspaceId ?? null,
              [STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY]: String(identity.isDirty),
            }
          : Object.fromEntries(
              SESSION_KEYS.map((key) => [key, localStorage.getItem(key)]),
            ),
      } satisfies PersonalDraft),
    );
  }
  cancelPendingSave();
  pauseLocalScenePersistence("collaboration-canvas");
}

export function restorePersonalDraft(api: ExcalidrawImperativeAPI): boolean {
  if (isSigningOut()) return false;
  const raw = sessionStorage.getItem(DRAFT_KEY);
  if (!raw) return false;
  const draft = JSON.parse(raw) as PersonalDraft;
  releaseCanvasRoom();
  // Clear the room's file store as well as its elements before enabling writes.
  api.resetScene();
  api.updateScene({
    elements: draft.canvas.elements,
    appState: {
      ...api.getAppState(),
      ...draft.canvas.appState,
      collaborators: new Map(),
      viewModeEnabled: false,
    },
  });
  api.addFiles(Object.values(draft.canvas.files));
  for (const key of SESSION_KEYS) {
    const value = draft.session[key];
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  resumeLocalScenePersistence("collaboration-canvas");
  saveToLocalStorage(
    draft.canvas.elements,
    draft.canvas.appState ?? {},
    draft.canvas.files,
  );
  clearPersonalDraft();
  return true;
}

/** Update the preserved source only after its explicit cloud commit succeeds. */
export function updatePreservedPersonalDraft(
  sceneId: string,
  revision: number,
  canvas: PersonalDraft["canvas"],
  expectedSceneId: string | undefined = sceneId,
): void {
  const raw = sessionStorage.getItem(DRAFT_KEY);
  if (!raw) {
    if (localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_ID) === sceneId) {
      for (const key of [
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
        STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
        STORAGE_KEYS.LOCAL_STORAGE_FILES,
      ])
        localStorage.removeItem(key);
    }
    return;
  }
  const draft = JSON.parse(raw) as PersonalDraft;
  if (
    (draft.session[STORAGE_KEYS.CURRENT_SCENE_ID] ?? undefined) !==
    expectedSceneId
  )
    return;
  draft.session[STORAGE_KEYS.CURRENT_SCENE_ID] = sceneId;
  draft.canvas = canvas;
  draft.session[STORAGE_KEYS.CURRENT_SCENE_REVISION] = String(revision);
  draft.session[STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY] = "false";
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function preservedSourceScene(): {
  id: string;
  name: string;
  revision: number | undefined;
} | null {
  const raw = sessionStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  const draft = JSON.parse(raw) as PersonalDraft;
  const id = draft.session[STORAGE_KEYS.CURRENT_SCENE_ID];
  if (!id) return null;
  const revision = Number(draft.session[STORAGE_KEYS.CURRENT_SCENE_REVISION]);
  return {
    id,
    name: draft.canvas.appState?.name ?? id,
    revision: Number.isInteger(revision) && revision > 0 ? revision : undefined,
  };
}

export function clearPersonalDraft(): void {
  sessionStorage.removeItem(DRAFT_KEY);
}
