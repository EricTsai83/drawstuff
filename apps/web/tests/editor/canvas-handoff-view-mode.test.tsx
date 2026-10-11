// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => ({
    suppressDirtyTracking: vi.fn(),
    resumeDirtyTracking: vi.fn(),
    getCurrentSceneIdentity: () => null,
  }),
}));
vi.mock("@/lib/collab/personal-draft", () => ({
  preservePersonalDraft: vi.fn(),
}));

const { useCanvasHandoff } =
  await import("@/hooks/excalidraw/use-canvas-handoff");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A viewer's `viewModeEnabled` prop is true before and after the handoff, so
 * Excalidraw never re-applies it. Upstream `resetScene()` restores the default
 * (editable) app state; the handoff must carry view mode across the reset or
 * the viewer gets the full editing UI.
 */
const appState = { viewModeEnabled: true };
const api = {
  getAppState: () => ({ ...appState }),
  resetScene: vi.fn(() => {
    appState.viewModeEnabled = false;
  }),
  updateScene: vi.fn((scene: { appState?: { viewModeEnabled?: boolean } }) => {
    if (scene.appState?.viewModeEnabled !== undefined)
      appState.viewModeEnabled = scene.appState.viewModeEnabled;
  }),
} as unknown as ExcalidrawImperativeAPI;

const probe: { result?: ReturnType<typeof useCanvasHandoff> } = {};
function Probe() {
  probe.result = useCanvasHandoff({
    excalidrawAPI: api,
    hasLocalContent: () => false,
    requestSceneChangeDecision: async () => "switch",
    resolveSceneChangeDecision: vi.fn(),
    closeSceneChangeConfirm: vi.fn(),
    uploadSceneToCloud: async () => true,
    cancelPendingSceneSave: vi.fn(),
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
});

const prepare = (keepCanvas: boolean) =>
  probe.result!.prepareCanvasForRoom({
    isCancelled: () => false,
    keepCanvas,
    onDecisionPrompt: vi.fn(),
  });

describe("canvas handoff keeps view mode across the reset", () => {
  it("keeps a viewer read-only after clearing the canvas", async () => {
    appState.viewModeEnabled = true;
    await expect(prepare(false)).resolves.toBe("prepared");
    expect(api.resetScene).toHaveBeenCalledOnce();
    expect(appState.viewModeEnabled).toBe(true);
  });

  it("leaves an editable canvas editable", async () => {
    appState.viewModeEnabled = false;
    await prepare(false);
    expect(appState.viewModeEnabled).toBe(false);
  });

  it("does not touch the scene when the canvas is kept", async () => {
    appState.viewModeEnabled = true;
    await prepare(true);
    expect(api.resetScene).not.toHaveBeenCalled();
    expect(api.updateScene).not.toHaveBeenCalled();
  });
});
