/** Per-tab holds: room content must never enter the personal canvas cache. */
export type LocalScenePersistenceLock = "collaboration-canvas" | "sign-out";
const locks = new Set<LocalScenePersistenceLock>();
export function pauseLocalScenePersistence(
  lock: LocalScenePersistenceLock,
): void {
  locks.add(lock);
}
export function resumeLocalScenePersistence(
  lock: LocalScenePersistenceLock,
): void {
  locks.delete(lock);
}
export function isLocalScenePersistencePaused(): boolean {
  return locks.size > 0;
}
export function isSigningOut(): boolean {
  return locks.has("sign-out");
}
