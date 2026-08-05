import { beforeEach, describe, expect, it } from "vitest";

import { STORAGE_KEYS } from "@/config/app-constants";
import {
  clearCurrentSceneSessionFromStorage,
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneIdToStorage,
} from "@/data/local-storage";
import {
  canvasBelongsToRoom,
  claimCanvasForRoom,
  readCanvasRoomId,
  releaseCanvasRoom,
} from "@/lib/collab/canvas-room-marker";

/**
 * The canvas claim replaces Plan 13's scene-id comparison as the session's
 * "is this still my canvas?" answer.
 *
 * It has to be a separate fact because a guest joining a room does not have — and
 * must never adopt — the owner's scene id: its own save would then try to
 * overwrite somebody else's scene. So the claim is released by the two storage
 * writers every canvas replacement already goes through, and these tests pin that
 * coupling, because a missed release would let room traffic land on an unrelated
 * scene.
 */

const ROOM = "room-alpha";
const OTHER_ROOM = "room-beta";
const SCENE = "scene-1";
const OTHER_SCENE = "scene-2";

describe("canvas room marker", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("is per tab, so another tab switching scenes cannot revoke it", () => {
    claimCanvasForRoom(ROOM);
    // `sessionStorage` is the storage that is both per-tab and reload-surviving.
    // In `localStorage` a second tab's scene switch would clear this claim and
    // silently stop a live session.
    expect(sessionStorage.getItem(STORAGE_KEYS.COLLAB_CANVAS_ROOM_ID)).toBe(
      ROOM,
    );
    expect(localStorage.getItem(STORAGE_KEYS.COLLAB_CANVAS_ROOM_ID)).toBeNull();
  });

  it("claims and releases the canvas for exactly one room", () => {
    expect(readCanvasRoomId()).toBeNull();
    expect(canvasBelongsToRoom(ROOM)).toBe(false);

    claimCanvasForRoom(ROOM);
    expect(canvasBelongsToRoom(ROOM)).toBe(true);
    expect(canvasBelongsToRoom(OTHER_ROOM)).toBe(false);

    releaseCanvasRoom();
    expect(canvasBelongsToRoom(ROOM)).toBe(false);
  });

  it("survives a reload, so a refresh inside a room stays inside it", () => {
    claimCanvasForRoom(ROOM);
    // Nothing in memory: a fresh read is all a reloaded page has. This is also
    // what lets the join skip the "replace this canvas?" prompt for a canvas that
    // is already the room's.
    expect(readCanvasRoomId()).toBe(ROOM);
    expect(canvasBelongsToRoom(ROOM)).toBe(true);
  });

  it("survives the room owner saving the scene the room is for", () => {
    saveCurrentSceneIdToStorage(SCENE);
    claimCanvasForRoom(ROOM);

    // Cmd+S on the room's own scene is not a canvas replacement.
    saveCurrentSceneIdToStorage(SCENE);
    expect(canvasBelongsToRoom(ROOM)).toBe(true);
    expect(loadCurrentSceneIdFromStorage()).toBe(SCENE);
  });

  it("survives a guest saving the room canvas as its own scene", () => {
    // A guest joins with the scene session cleared, so it has no scene id at all,
    // and its first cloud save writes a brand-new one.
    claimCanvasForRoom(ROOM);
    expect(loadCurrentSceneIdFromStorage()).toBeUndefined();

    saveCurrentSceneIdToStorage(OTHER_SCENE);
    // Saving a copy does not replace the canvas, so the guest stays in the room.
    // Releasing here would silently stop all room sync mid-session while the UI
    // still reported "collaborating".
    expect(canvasBelongsToRoom(ROOM)).toBe(true);
  });

  it("is not released by writing a scene id, only by replacing the canvas", () => {
    saveCurrentSceneIdToStorage(SCENE);
    claimCanvasForRoom(ROOM);

    // Writing an id is not the same event as swapping the canvas; the release
    // belongs to the replacement sites (`use-apply-remote-scene`, new scene).
    saveCurrentSceneIdToStorage(OTHER_SCENE);
    expect(canvasBelongsToRoom(ROOM)).toBe(true);
  });

  it("is released when the scene session is cleared for a new scene", () => {
    saveCurrentSceneIdToStorage(SCENE);
    claimCanvasForRoom(ROOM);

    clearCurrentSceneSessionFromStorage();
    expect(canvasBelongsToRoom(ROOM)).toBe(false);
    expect(loadCurrentSceneIdFromStorage()).toBeUndefined();
  });
});
