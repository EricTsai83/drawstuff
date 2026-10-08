// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "@/config/app-constants";
import {
  clearLocalSceneStorage,
  readSignedOutDraftMarker,
  writeSignedOutDraftMarker,
} from "@/data/local-storage";
import {
  compareDraftLineage,
  detachedMarker,
  resolveSignedOutDraftAction,
} from "@/hooks/excalidraw/use-signed-out-draft";

afterEach(() => localStorage.clear());

describe("resolveSignedOutDraftAction", () => {
  const base = {
    marker: { detachedFrom: "Roadmap", kept: false, elementIds: ["a"] },
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
        marker: null,
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

  it("settles once the canvas is bound to a scene, even a kept draft", () => {
    const hasContent = vi.fn(() => true);
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-in",
        marker: { detachedFrom: "Roadmap", kept: true, elementIds: ["a"] },
        currentSceneId: "scene-new",
        hasContent,
      }),
    ).toBe("settle");
    expect(hasContent).not.toHaveBeenCalled();
  });

  it("does not ask again about a draft the user chose to keep", () => {
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-in",
        marker: { detachedFrom: "Roadmap", kept: true, elementIds: ["a"] },
      }),
    ).toBe("none");
  });

  it("ignores a signed-in canvas that was never signed out", () => {
    expect(
      resolveSignedOutDraftAction({
        ...base,
        authState: "signed-in",
        marker: null,
      }),
    ).toBe("none");
  });
});

describe("detachedMarker", () => {
  it("records the bound scene and its elements, starting a fresh decision", () => {
    expect(
      detachedMarker(
        { detachedFrom: "Old", kept: true, elementIds: ["old"] },
        { id: "scene-x", name: " Roadmap ", elementIds: ["a", "b"] },
      ),
    ).toEqual({ detachedFrom: "Roadmap", kept: false, elementIds: ["a", "b"] });
  });

  it("keeps an existing marker when no scene is bound", () => {
    const previous = { detachedFrom: "Roadmap", kept: true, elementIds: ["a"] };
    expect(
      detachedMarker(previous, { id: undefined, name: "", elementIds: [] }),
    ).toBe(previous);
    expect(
      detachedMarker(null, { id: undefined, name: "Draft", elementIds: ["z"] }),
    ).toEqual({ detachedFrom: null, kept: false, elementIds: [] });
  });
});

describe("compareDraftLineage", () => {
  const draft = new Set(["a", "b"]);

  it("is the same draft while any of its elements remain", () => {
    expect(compareDraftLineage(draft, [{ id: "new" }, { id: "b" }])).toBe(
      "same",
    );
  });

  it("is replaced once a non-empty canvas holds none of them", () => {
    expect(compareDraftLineage(draft, [{ id: "loaded" }])).toBe("replaced");
    // Deleted originals do not count as remaining.
    expect(
      compareDraftLineage(draft, [
        { id: "a", isDeleted: true },
        { id: "loaded" },
      ]),
    ).toBe("replaced");
  });

  it("leaves an empty canvas undecided", () => {
    expect(compareDraftLineage(draft, [])).toBe("empty");
    expect(compareDraftLineage(draft, [{ id: "a", isDeleted: true }])).toBe(
      "empty",
    );
  });
});

describe("signed-out draft marker", () => {
  it("round-trips through localStorage", () => {
    expect(readSignedOutDraftMarker()).toBeNull();
    writeSignedOutDraftMarker({
      detachedFrom: "Roadmap",
      kept: true,
      elementIds: ["a"],
    });
    expect(readSignedOutDraftMarker()).toEqual({
      detachedFrom: "Roadmap",
      kept: true,
      elementIds: ["a"],
    });
    writeSignedOutDraftMarker(null);
    expect(localStorage.getItem(STORAGE_KEYS.SIGNED_OUT_DRAFT)).toBeNull();
  });

  it("reads markers written before the scene name was recorded", () => {
    localStorage.setItem(STORAGE_KEYS.SIGNED_OUT_DRAFT, "true");
    expect(readSignedOutDraftMarker()).toEqual({
      detachedFrom: null,
      kept: false,
      elementIds: [],
    });
  });

  it("treats a malformed marker as absent", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    localStorage.setItem(STORAGE_KEYS.SIGNED_OUT_DRAFT, "{not json");
    expect(readSignedOutDraftMarker()).toBeNull();
    vi.restoreAllMocks();
  });

  it("is cleared with the rest of the local canvas", () => {
    writeSignedOutDraftMarker({
      detachedFrom: "Roadmap",
      kept: false,
      elementIds: ["a"],
    });
    clearLocalSceneStorage();
    expect(readSignedOutDraftMarker()).toBeNull();
  });
});
