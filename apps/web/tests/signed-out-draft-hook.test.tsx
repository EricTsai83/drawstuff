// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { STORAGE_KEYS } from "@/config/app-constants";
import { readSignedOutDraftMarker } from "@/data/local-storage";
import type { AuthState } from "@/hooks/excalidraw/use-signed-out-draft";

const session = {
  currentSceneId: undefined as string | undefined,
  isSessionReady: true,
  clearCurrentScene: vi.fn(() => {
    session.currentSceneId = undefined;
  }),
  suppressDirtyTracking: vi.fn(),
  resumeDirtyTracking: vi.fn(),
};
vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => session,
}));

const { useSignedOutDraft } =
  await import("@/hooks/excalidraw/use-signed-out-draft");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// What the engine currently shows.
const canvas = {
  name: "Roadmap",
  elements: [{ id: "a" }, { id: "b" }] as { id: string; isDeleted?: boolean }[],
};
const api = {
  resetScene: vi.fn(),
  getSceneElements: () => canvas.elements.filter((e) => !e.isDeleted),
  getAppState: () => ({ name: canvas.name }),
} as unknown as ExcalidrawImperativeAPI;
const hasContent = () => true;
const probe: { result?: ReturnType<typeof useSignedOutDraft> } = {};

function Probe(props: { authState: AuthState; isRoomMode: boolean }) {
  probe.result = useSignedOutDraft({
    excalidrawAPI: api,
    authState: props.authState,
    isRoomMode: props.isRoomMode,
    hasCurrentCanvasContent: hasContent,
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = (authState: AuthState, isRoomMode = false) =>
  act(() =>
    root.render(<Probe authState={authState} isRoomMode={isRoomMode} />),
  );
const change = (elements: { id: string; isDeleted?: boolean }[]) => {
  canvas.elements = elements;
  act(() => probe.result?.observeCanvas(elements));
};
/** Lapse while bound to "Roadmap", sign back in, and keep the draft. */
const keepDetachedDraft = () => {
  session.currentSceneId = "scene-x";
  render("signed-out");
  render("signed-in");
  act(() => probe.result?.keepSignedOutDraft());
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  session.currentSceneId = undefined;
  canvas.name = "Roadmap";
  canvas.elements = [{ id: "a" }, { id: "b" }];
  probe.result = undefined;
  vi.clearAllMocks();
});

describe("useSignedOutDraft", () => {
  it("detaches a bound canvas once signed out, recording its scene and elements", () => {
    session.currentSceneId = "scene-x";
    render("signed-out");
    expect(session.clearCurrentScene).toHaveBeenCalledTimes(1);
    expect(readSignedOutDraftMarker()).toEqual({
      detachedFrom: "Roadmap",
      kept: false,
      elementIds: ["a", "b"],
    });
    expect(probe.result?.needsDecision).toBe(false);
    expect(probe.result?.detachedFromSceneName).toBe("Roadmap");
  });

  it("leaves the binding alone while the session is unknown", () => {
    session.currentSceneId = "scene-x";
    render("unknown");
    expect(session.clearCurrentScene).not.toHaveBeenCalled();
    expect(readSignedOutDraftMarker()).toBeNull();
  });

  it("asks after signing in with a signed-out draft", () => {
    render("signed-out");
    render("signed-in");
    expect(probe.result?.needsDecision).toBe(true);
  });

  it("withdraws the question when the session is lost again", () => {
    render("signed-out");
    render("signed-in");
    expect(probe.result?.needsDecision).toBe(true);
    render("signed-out");
    expect(probe.result?.needsDecision).toBe(false);
    expect(readSignedOutDraftMarker()).not.toBeNull();
    // The kept marker asks again on the next sign-in.
    render("signed-in");
    expect(probe.result?.needsDecision).toBe(true);
  });

  it("keeps an unsaved draft labelled without asking again", () => {
    keepDetachedDraft();
    expect(probe.result?.needsDecision).toBe(false);
    expect(probe.result?.detachedFromSceneName).toBe("Roadmap");
    expect(api.resetScene).not.toHaveBeenCalled();
    // Neither a later sign-in nor another lapse brings the question back.
    render("signed-out");
    render("signed-in");
    expect(probe.result?.needsDecision).toBe(false);
    expect(probe.result?.detachedFromSceneName).toBe("Roadmap");
  });

  it("keeps the draft's provenance when the canvas is renamed or edited", () => {
    keepDetachedDraft();
    canvas.name = "Roadmap v2";
    change([{ id: "a" }, { id: "new" }]);
    render("signed-in");
    expect(probe.result?.detachedFromSceneName).toBe("Roadmap");
    expect(readSignedOutDraftMarker()?.kept).toBe(true);
  });

  it("uses the live canvas, not a stale persisted copy, once it shows content", () => {
    // A rename not yet flushed to storage when the session lapses.
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify({ name: "Old name" }),
    );
    session.currentSceneId = "scene-x";
    render("signed-out");
    expect(readSignedOutDraftMarker()?.detachedFrom).toBe("Roadmap");
  });

  it("uses the persisted scene while the canvas is still restoring", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify({ name: "Roadmap" }),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([{ id: "a" }, { id: "b" }]),
    );
    // The engine has not applied the restored data and reports a default name.
    canvas.elements = [];
    canvas.name = "Untitled-2026-10-09-0012";
    session.currentSceneId = "scene-x";
    render("signed-out");
    expect(readSignedOutDraftMarker()).toEqual({
      detachedFrom: "Roadmap",
      kept: false,
      elementIds: ["a", "b"],
    });
  });

  it("hides the label on an emptied canvas without resolving the draft", () => {
    keepDetachedDraft();
    change([
      { id: "a", isDeleted: true },
      { id: "b", isDeleted: true },
    ]);
    expect(probe.result?.detachedFromSceneName).toBeNull();
    expect(readSignedOutDraftMarker()?.kept).toBe(true);
    // Undoing the clear brings the draft, and its label, back.
    change([{ id: "a" }]);
    expect(probe.result?.detachedFromSceneName).toBe("Roadmap");
  });

  it("resolves a kept draft once another canvas replaces it", () => {
    keepDetachedDraft();
    change([{ id: "loaded-from-file" }]);
    expect(readSignedOutDraftMarker()).toBeNull();
    expect(probe.result?.detachedFromSceneName).toBeNull();
  });

  it("asks about a canvas that replaced a kept draft while signed out", () => {
    keepDetachedDraft();
    render("signed-out");
    change([{ id: "loaded-from-file" }]);
    expect(readSignedOutDraftMarker()).toEqual({
      detachedFrom: null,
      kept: false,
      elementIds: [],
    });
    render("signed-in");
    expect(probe.result?.needsDecision).toBe(true);
    expect(probe.result?.detachedFromSceneName).toBeNull();
  });

  it("ignores room canvases, which are not the personal draft", () => {
    keepDetachedDraft();
    render("signed-in", true);
    change([{ id: "room-element" }]);
    expect(readSignedOutDraftMarker()?.kept).toBe(true);
    expect(probe.result?.detachedFromSceneName).toBeNull();
  });

  it("resolves a kept draft once it is saved as a scene", () => {
    keepDetachedDraft();
    session.currentSceneId = "scene-new";
    render("signed-in");
    expect(readSignedOutDraftMarker()).toBeNull();
    expect(probe.result?.detachedFromSceneName).toBeNull();
  });

  it("discards the draft and its label", () => {
    session.currentSceneId = "scene-x";
    render("signed-out");
    render("signed-in");
    act(() => probe.result?.discardSignedOutDraft());
    expect(api.resetScene).toHaveBeenCalledTimes(1);
    expect(probe.result?.needsDecision).toBe(false);
    expect(probe.result?.detachedFromSceneName).toBeNull();
    expect(readSignedOutDraftMarker()).toBeNull();
  });
});
