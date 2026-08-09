import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  claimCanvasForRoom,
  readCanvasRoomId,
} from "@/lib/collab/canvas-room-marker";
import { clearCanvasForWorkspaceDeletion } from "@/lib/workspace-deletion";

describe("current workspace deletion safety", () => {
  it("cancels saves, clears the session, suppresses reset changes and releases the room claim", () => {
    const order: string[] = [];
    const resumeDirtyTracking = vi.fn(() => order.push("resume"));
    const scheduled: Array<() => void> = [];
    const resetScene = vi.fn(() => order.push("canvas"));
    const excalidrawAPI = { resetScene } as unknown as ExcalidrawImperativeAPI;

    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "deleted-scene");
    localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, crypto.randomUUID());
    claimCanvasForRoom("active-room");

    clearCanvasForWorkspaceDeletion({
      excalidrawAPI,
      cancelPendingSceneSave: () => order.push("cancel"),
      clearCurrentScene: () => order.push("session"),
      suppressDirtyTracking: () => order.push("suppress"),
      resumeDirtyTracking,
      scheduleResume: (callback) => scheduled.push(callback),
    });

    expect(order).toEqual(["cancel", "session", "suppress", "canvas"]);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_ID)).toBeNull();
    expect(readCanvasRoomId()).toBeNull();
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    expect(resumeDirtyTracking).toHaveBeenCalledOnce();
  });

  it("still clears storage and resumes tracking when resetScene throws", () => {
    const resumeDirtyTracking = vi.fn();
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "deleted-image");

    expect(() =>
      clearCanvasForWorkspaceDeletion({
        excalidrawAPI: {
          resetScene: () => {
            throw new Error("reset failed");
          },
        } as unknown as ExcalidrawImperativeAPI,
        cancelPendingSceneSave: vi.fn(),
        clearCurrentScene: vi.fn(),
        suppressDirtyTracking: vi.fn(),
        resumeDirtyTracking,
        scheduleResume: (callback) => callback(),
      }),
    ).toThrow("reset failed");

    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES)).toBeNull();
    expect(resumeDirtyTracking).toHaveBeenCalledOnce();
  });
});
