import type { SyncedElement } from "@drawstuff/collaboration/protocol";

/**
 * Rooms this tab just initialized from the canvas on screen.
 *
 * The join that follows a successful initialization replaces the canvas with
 * the room's baseline — the same content the owner just stored. Asking that
 * owner to "save or discard" the canvas first would offer a personal cloud save
 * the standalone flow promised not to make.
 *
 * The exemption is bound to the exact canvas that was stored: it applies only
 * while the on-screen elements still match, so a retried join keeps it and an
 * edited or replaced canvas loses it. Only the room id and an element-version
 * fingerprint are held, in memory for this tab.
 */
const initializedFromCanvas = new Map<string, string>();

const fingerprint = (elements: readonly SyncedElement[]): string =>
  elements
    .map(
      (element) =>
        `${element.id}:${element.version}:${element.versionNonce}:${element.isDeleted ? 1 : 0}`,
    )
    .sort()
    .join("|");

export function markRoomInitializedFromCanvas(
  roomId: string,
  elements: readonly SyncedElement[],
): void {
  initializedFromCanvas.set(roomId, fingerprint(elements));
}

/** True only while the on-screen canvas is still the one this room was initialized from. */
export function isCanvasInitializedForRoom(
  roomId: string,
  elements: readonly SyncedElement[],
): boolean {
  return initializedFromCanvas.get(roomId) === fingerprint(elements);
}

/** Drops the exemption once the canvas handoff to the room has succeeded. */
export function clearRoomInitializedFromCanvas(roomId: string): void {
  initializedFromCanvas.delete(roomId);
}
