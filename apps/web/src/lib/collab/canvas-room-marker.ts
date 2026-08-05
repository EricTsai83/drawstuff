import { STORAGE_KEYS } from "@/config/app-constants";

/**
 * Records that the canvas currently on screen *is* a collaboration room's
 * scene.
 *
 * The session needs a synchronous answer to "may I still read and write this
 * canvas?", and comparing scene ids cannot give it. A guest joining a room does
 * not have the owner's scene and must never adopt its id (its own save would
 * then try to overwrite somebody else's scene), so there is no id to compare
 * against — the canvas belongs to the room, not to a scene the guest owns.
 *
 * The claim lives in `sessionStorage`, which is the only storage with both
 * properties this needs:
 *
 * - **Per tab.** A claim describes one editor instance's canvas. In
 *   `localStorage` a second tab switching scenes would clear the first tab's
 *   valid claim and silently stop a live session — and a later claim for the same
 *   room in either tab would re-enable a session whose canvas had already been
 *   replaced.
 * - **Survives a reload.** Refreshing inside a room must not turn the canvas back
 *   into a private scene.
 *
 * The claim is deliberately *not* used to skip the join's "replace this canvas?"
 * prompt. A guest's canvas is no longer cached locally while a room owns it
 * (`@/data/local-scene-persistence`), so what a reload restores is the guest's own
 * pre-join scene — content that genuinely has to go through that prompt.
 *
 * Release is centralized where it can be: the two scene-session storage writers
 * (`@/data/local-storage`) cover loading another cloud scene and starting a new
 * one, and they do it in the same synchronous block that swaps the canvas — which
 * closes the window a React prop comparison would leave open. Paths that replace
 * the canvas *without* touching the scene session — upstream's own file import —
 * are not covered by that and must release explicitly or be withheld while a room
 * is connected; see `app-main-menu.tsx`.
 */

const canUseSessionStorage = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.sessionStorage !== "undefined";

/** Marks the on-screen canvas as this room's scene. */
export function claimCanvasForRoom(roomId: string): void {
  if (!canUseSessionStorage()) return;
  try {
    sessionStorage.setItem(STORAGE_KEYS.COLLAB_CANVAS_ROOM_ID, roomId);
  } catch (error: unknown) {
    console.error(error);
  }
}

/** Drops the claim: this canvas is no longer any room's scene. */
export function releaseCanvasRoom(): void {
  if (!canUseSessionStorage()) return;
  try {
    sessionStorage.removeItem(STORAGE_KEYS.COLLAB_CANVAS_ROOM_ID);
  } catch (error: unknown) {
    console.error(error);
  }
}

export function readCanvasRoomId(): string | null {
  if (!canUseSessionStorage()) return null;
  try {
    return sessionStorage.getItem(STORAGE_KEYS.COLLAB_CANVAS_ROOM_ID);
  } catch (error: unknown) {
    console.error(error);
    return null;
  }
}

/**
 * The session's synchronous guard. False means the canvas was replaced (another
 * scene loaded, a new scene started, the room left), so room traffic must not be
 * applied to it and its contents must not be published into the room.
 */
export function canvasBelongsToRoom(roomId: string): boolean {
  return readCanvasRoomId() === roomId;
}
