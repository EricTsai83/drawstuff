// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { hasSignedOutDraftMarker } from "@/data/local-storage";
import type { AuthState } from "@/hooks/excalidraw/use-signed-out-draft";

const session = {
  currentSceneId: undefined as string | undefined,
  isSessionReady: true,
  clearCurrentScene: vi.fn(),
  suppressDirtyTracking: vi.fn(),
  resumeDirtyTracking: vi.fn(),
};
vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => session,
}));

const { useSignedOutDraft } = await import(
  "@/hooks/excalidraw/use-signed-out-draft"
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = { resetScene: vi.fn() } as unknown as ExcalidrawImperativeAPI;
const hasContent = () => true;
const result: { needsDecision?: boolean } = {};

function Probe({ authState }: { authState: AuthState }) {
  const { needsDecision } = useSignedOutDraft({
    excalidrawAPI: api,
    authState,
    isRoomMode: false,
    hasCurrentCanvasContent: hasContent,
  });
  result.needsDecision = needsDecision;
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = (authState: AuthState) =>
  act(() => root.render(<Probe authState={authState} />));

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
  vi.clearAllMocks();
});

describe("useSignedOutDraft", () => {
  it("detaches a bound canvas once signed out", () => {
    session.currentSceneId = "scene-x";
    render("signed-out");
    expect(session.clearCurrentScene).toHaveBeenCalledTimes(1);
    expect(hasSignedOutDraftMarker()).toBe(true);
    expect(result.needsDecision).toBe(false);
  });

  it("leaves the binding alone while the session is unknown", () => {
    session.currentSceneId = "scene-x";
    render("unknown");
    expect(session.clearCurrentScene).not.toHaveBeenCalled();
    expect(hasSignedOutDraftMarker()).toBe(false);
  });

  it("asks after signing in with a signed-out draft", () => {
    render("signed-out");
    render("signed-in");
    expect(result.needsDecision).toBe(true);
  });

  it("withdraws the question when the session is lost again", () => {
    render("signed-out");
    render("signed-in");
    expect(result.needsDecision).toBe(true);
    render("signed-out");
    expect(result.needsDecision).toBe(false);
    expect(hasSignedOutDraftMarker()).toBe(true);
    // The kept marker asks again on the next sign-in.
    render("signed-in");
    expect(result.needsDecision).toBe(true);
  });
});
