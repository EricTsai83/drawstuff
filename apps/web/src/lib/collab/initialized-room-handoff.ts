/**
 * Rooms this tab just initialized from the canvas on screen.
 *
 * The join that follows a successful initialization replaces the canvas with
 * the room's baseline — the same content the owner just encrypted. Asking that
 * owner to "save or discard" the canvas first would offer a personal cloud save
 * the standalone flow promised not to make. Only the room id is held, in memory
 * for this tab, and each mark is consumed by the next join of that room.
 */
const initializedFromCanvas = new Set<string>();

export function markRoomInitializedFromCanvas(roomId: string): void {
  initializedFromCanvas.add(roomId);
}

export function consumeRoomInitializedFromCanvas(roomId: string): boolean {
  return initializedFromCanvas.delete(roomId);
}
