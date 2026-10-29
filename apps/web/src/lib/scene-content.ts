import { OFFICIAL_SERVER_APP_STATE_KEYS } from "@drawstuff/excalidraw-adapter/codec";
import type {
  AppState,
  ExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

type SceneContent = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
};

/** Compare scene content only at the two async boundaries, never on each frame.
 * Selection, panning and opening sidebars do not invalidate a pending load. */
export function captureSceneContent(scene: SceneContent) {
  const state = scene.appState;
  return {
    elements: scene.elements.map((element) => ({
      id: element.id,
      version: element.version,
      versionNonce: element.versionNonce,
      isDeleted: element.isDeleted,
    })),
    name: state.name,
    appState: Object.fromEntries(
      OFFICIAL_SERVER_APP_STATE_KEYS.map((key) => [key, state[key]]),
    ),
  };
}

export function hasSceneContentChanged(
  scene: SceneContent,
  snapshot: ReturnType<typeof captureSceneContent>,
): boolean {
  const elements = scene.elements;
  const state = scene.appState;
  return (
    state.name !== snapshot.name ||
    OFFICIAL_SERVER_APP_STATE_KEYS.some(
      (key) => state[key] !== snapshot.appState[key],
    ) ||
    elements.length !== snapshot.elements.length ||
    elements.some((element, index) => {
      const previous = snapshot.elements[index]!;
      return (
        element.id !== previous.id ||
        element.version !== previous.version ||
        element.versionNonce !== previous.versionNonce ||
        element.isDeleted !== previous.isDeleted
      );
    })
  );
}
