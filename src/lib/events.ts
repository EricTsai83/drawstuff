export const LOAD_SCENE_EVENT = "exc:load-scene" as const;

export type LoadSceneRequestDetail = {
  sceneId: string;
  workspaceId?: string;
};

export function dispatchLoadSceneRequest(detail: LoadSceneRequestDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOAD_SCENE_EVENT, { detail }));
}
