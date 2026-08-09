import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  isLocalScenePersistencePaused,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";
import { clearLocalSceneStorage } from "@/data/local-storage";
import {
  claimCanvasForRoom,
  readCanvasRoomId,
} from "@/lib/collab/canvas-room-marker";
import { clearCanvasForSignOut } from "@/lib/sign-out";

const sensitiveKeys = [
  STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
  STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
  STORAGE_KEYS.LOCAL_STORAGE_FILES,
  STORAGE_KEYS.VERSION_DATA_STATE,
  STORAGE_KEYS.VERSION_FILES,
  STORAGE_KEYS.CURRENT_SCENE_ID,
  STORAGE_KEYS.CURRENT_SCENE_REVISION,
  STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY,
  STORAGE_KEYS.CURRENT_SCENE_WORKSPACE_ID,
] as const;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resumeLocalScenePersistence("sign-out");
});

afterEach(() => {
  resumeLocalScenePersistence("sign-out");
});

describe("sign-out browser privacy", () => {
  it("removes scene data while preserving preferences and the library", () => {
    for (const key of sensitiveKeys) localStorage.setItem(key, "private");
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, "dark");
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE, "zh-TW");
    localStorage.setItem(STORAGE_KEYS.IDB_LIBRARY, "user-scoped-library");
    localStorage.setItem("unrelated-app-key", "keep");
    claimCanvasForRoom("private-room");

    clearLocalSceneStorage();

    for (const key of sensitiveKeys)
      expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME)).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE)).toBe(
      "zh-TW",
    );
    expect(localStorage.getItem(STORAGE_KEYS.IDB_LIBRARY)).toBe(
      "user-scoped-library",
    );
    expect(localStorage.getItem("unrelated-app-key")).toBe("keep");
    expect(readCanvasRoomId()).toBeNull();
  });

  it("stops writers before clearing the session and visible canvas", () => {
    const order: string[] = [];
    const cancelPendingSceneSave = vi.fn(() => order.push("cancel"));
    const clearCurrentScene = vi.fn(() => order.push("session"));
    const suppressDirtyTracking = vi.fn(() => order.push("suppress"));
    const resetScene = vi.fn(() => order.push("canvas"));
    const excalidrawAPI = { resetScene } as unknown as ExcalidrawImperativeAPI;
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "private");

    clearCanvasForSignOut({
      excalidrawAPI,
      cancelPendingSceneSave,
      clearCurrentScene,
      suppressDirtyTracking,
    });

    expect(isLocalScenePersistencePaused()).toBe(true);
    expect(order).toEqual(["cancel", "session", "suppress", "canvas"]);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).toBeNull();
  });

  it("still removes browser data when the canvas engine reset fails", () => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "private-image");
    const excalidrawAPI = {
      resetScene: () => {
        throw new Error("engine failed");
      },
    } as unknown as ExcalidrawImperativeAPI;

    expect(() =>
      clearCanvasForSignOut({
        excalidrawAPI,
        cancelPendingSceneSave: vi.fn(),
        clearCurrentScene: vi.fn(),
        suppressDirtyTracking: vi.fn(),
      }),
    ).toThrow("engine failed");
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES)).toBeNull();
  });
});
