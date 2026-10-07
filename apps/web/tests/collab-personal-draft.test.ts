// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
  isLocalScenePersistencePaused,
} from "@/data/local-scene-persistence";
import {
  clearLocalSceneStorage,
  importFromLocalStorage,
} from "@/data/local-storage";
import { claimCanvasForRoom } from "@/lib/collab/canvas-room-marker";
import {
  preservePersonalDraft,
  restorePersonalDraft,
  updatePreservedPersonalDraft,
} from "@/lib/collab/personal-draft";
import {
  createInitialDataPromise,
  saveData,
  saveToLocalStorage,
} from "@/lib/excalidraw";
import { collabRectangle } from "./support/collab-scene-fixtures";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resumeLocalScenePersistence("collaboration-canvas");
  resumeLocalScenePersistence("sign-out");
  window.history.replaceState({}, "", "/");
});

function host() {
  let elements: readonly OrderedExcalidrawElement[] = [
    collabRectangle({ id: "personal-draft" }),
  ];
  let state = { name: "Personal original" } as AppState;
  let files: BinaryFiles = {};
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => state,
    getFiles: () => files,
    resetScene: () => {
      elements = [];
      files = {};
    },
    updateScene: (next: {
      elements?: readonly OrderedExcalidrawElement[];
      appState?: AppState;
    }) => {
      if (next.elements) elements = next.elements;
      if (next.appState) state = next.appState;
    },
    addFiles: () => undefined,
  } as unknown as ExcalidrawImperativeAPI;
  return {
    api,
    get elements() {
      return elements;
    },
  };
}

function enterRoom() {
  const h = host();
  saveToLocalStorage(h.elements, h.api.getAppState(), {});
  localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, "source");
  localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_REVISION, "3");
  const cancel = vi.fn();
  preservePersonalDraft(h.api, cancel);
  expect(cancel).toHaveBeenCalledOnce();
  claimCanvasForRoom("room");
  h.api.updateScene({ elements: [collabRectangle({ id: "room-secret" })] });
  return h;
}

describe("room and personal cache separation", () => {
  it("owner edits, delayed saves and unload writers cannot cache room contents", () => {
    const h = enterRoom();
    saveData({
      elements: h.elements,
      appState: h.api.getAppState(),
      files: {},
    });
    saveToLocalStorage(h.elements, h.api.getAppState(), {});
    expect(importFromLocalStorage().elements.map((e) => e.id)).toEqual([
      "personal-draft",
    ]);
    expect(
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ).not.toContain("room-secret");
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_ID)).toBe("source");
    restorePersonalDraft(h.api);
    expect(h.elements.map((e) => e.id)).toEqual(["personal-draft"]);
    expect(isLocalScenePersistencePaused()).toBe(false);
  });

  it("reload with a missing key renders no personal cache into the room", async () => {
    const h = enterRoom();
    window.history.replaceState({}, "", "/?room=room");
    // The actual query key is the exported collaboration-room parameter.
    const { COLLABORATION_ROOM_PARAM } = await import("@/lib/collab/room-link");
    window.history.replaceState({}, "", `/?${COLLABORATION_ROOM_PARAM}=room`);
    const initial = await createInitialDataPromise();
    expect(initial?.elements).toEqual([]);
    expect(initial?.files).toEqual({});
    restorePersonalDraft(h.api);
    expect(h.elements.map((e) => e.id)).toEqual(["personal-draft"]);
  });

  it("another tab's personal cache cannot replace this tab's preserved original", () => {
    const h = enterRoom();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([collabRectangle({ id: "other-tab" })]),
    );
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, "other-source");
    restorePersonalDraft(h.api);
    expect(h.elements.map((e) => e.id)).toEqual(["personal-draft"]);
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_ID)).toBe("source");
  });

  it("an explicit source commit updates its preserved cache and revision before restore", () => {
    const h = enterRoom();
    updatePreservedPersonalDraft("source", 4, {
      elements: [...h.elements],
      appState: h.api.getAppState(),
      files: {},
    });
    restorePersonalDraft(h.api);
    expect(h.elements.map((e) => e.id)).toEqual(["room-secret"]);
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_REVISION)).toBe("4");
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY)).toBe(
      "false",
    );
  });

  it("entry uses this tab's identity even if another tab changed shared storage", () => {
    const h = host();
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, "other-tab");
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_REVISION, "99");
    preservePersonalDraft(h.api, () => undefined, {
      id: "my-source",
      revision: 7,
      workspaceId: "my-workspace",
      isDirty: true,
    });
    restorePersonalDraft(h.api);
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_ID)).toBe(
      "my-source",
    );
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_REVISION)).toBe("7");
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY)).toBe(
      "true",
    );
  });

  it("a source commit completing after leave invalidates the restored stale cache", () => {
    const h = enterRoom();
    restorePersonalDraft(h.api);
    updatePreservedPersonalDraft("source", 4, {
      elements: [collabRectangle({ id: "committed-source" })],
      appState: {},
      files: {},
    });
    expect(importFromLocalStorage().elements).toEqual([]);
    // Keep the old revision so the open stale personal canvas cannot silently overwrite it.
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_REVISION)).toBe("3");
  });

  it("sign-out and local cleanup cannot resurrect the personal draft", () => {
    const h = enterRoom();
    pauseLocalScenePersistence("sign-out");
    clearLocalSceneStorage();
    expect(
      sessionStorage.getItem(STORAGE_KEYS.PERSONAL_DRAFT_BEFORE_ROOM),
    ).toBeNull();
    expect(restorePersonalDraft(h.api)).toBe(false);
  });
});
