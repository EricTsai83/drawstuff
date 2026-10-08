// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "@/config/app-constants";
import {
  clearLocalSceneStorage,
  hasSignedOutDraftMarker,
  setSignedOutDraftMarker,
} from "@/data/local-storage";
import { resolveSignedOutDraftAction } from "@/hooks/excalidraw/use-signed-out-draft";

afterEach(() => localStorage.clear());

describe("resolveSignedOutDraftAction", () => {
  const base = {
    hasMarker: true,
    currentSceneId: undefined,
    hasContent: () => true,
  };

  it("does nothing until the session is known", () => {
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "unknown",
        currentSceneId: "scene-x",
      }),
    ).toBe("none");
  });

  it("detaches whenever signed out, even from a bound scene", () => {
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-out",
        hasMarker: false,
        currentSceneId: "scene-x",
      }),
    ).toBe("detach");
  });

  it("asks about a non-empty signed-out draft after signing in", () => {
    expect(
      resolveSignedOutDraftAction({ ...base, authState: "signed-in" }),
    ).toBe("prompt");
  });

  it("settles without asking when the draft is empty", () => {
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-in",
        hasContent: () => false,
      }),
    ).toBe("settle");
  });

  it("settles without asking when the canvas is already bound", () => {
    const hasContent = vi.fn(() => true);
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-in",
        currentSceneId: "scene-new",
        hasContent,
      }),
    ).toBe("settle");
    expect(hasContent).not.toHaveBeenCalled();
  });

  it("ignores a signed-in canvas that was never signed out", () => {
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-in",
        hasMarker: false,
      }),
    ).toBe("none");
  });
});

describe("signed-out draft marker", () => {
  it("round-trips through localStorage", () => {
    expect(hasSignedOutDraftMarker()).toBe(false);
    setSignedOutDraftMarker(true);
    expect(localStorage.getItem(STORAGE_KEYS.SIGNED_OUT_DRAFT)).toBe("true");
    expect(hasSignedOutDraftMarker()).toBe(true);
    setSignedOutDraftMarker(false);
    expect(hasSignedOutDraftMarker()).toBe(false);
  });

  it("is cleared with the rest of the local canvas", () => {
    setSignedOutDraftMarker(true);
    clearLocalSceneStorage();
    expect(hasSignedOutDraftMarker()).toBe(false);
  });
});
