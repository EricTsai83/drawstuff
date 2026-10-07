import { isLocalScenePersistencePaused } from "@/data/local-scene-persistence";
import { readCanvasRoomId } from "@/lib/collab/canvas-room-marker";

/** Shared synchronous destination decision for every canvas save entry. */
export function getEditorStorageMode(): "room" | "personal" {
  return readCanvasRoomId() !== null || isLocalScenePersistencePaused()
    ? "room"
    : "personal";
}
