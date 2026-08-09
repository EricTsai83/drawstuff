/**
 * Lock that suspends caching the canvas into browser storage.
 *
 * Modelled on upstream's `LocalData.pauseSave` / `Locker`
 * (`excalidraw-app/data/LocalData.ts`, `data/Locker.ts` at 0.18.1), which the
 * upstream app engages for the whole duration of a collaboration session. The
 * mechanism transfers; the blanket policy does not, and the difference is worth
 * stating because it is the reason this module exists rather than a single
 * boolean at the call site.
 *
 * Upstream's browser storage *is* the scene: pausing it while a room owns the
 * canvas simply means the room's content never lands on disk, and a reload
 * re-joins from the URL and re-fetches the baseline. Drawstuff's browser storage
 * is a *cache of an owned cloud scene*, so pausing it unconditionally would be
 * unsafe: the room owner's cache would go stale, a reload would restore that
 * stale content into the canvas, and the very next save would upload it over
 * their newer cloud scene.
 *
 * So the lock is engaged for exactly the case where upstream's reasoning holds
 * unchanged — a canvas that belongs to a room with no owned scene behind it,
 * where the cache would otherwise accumulate another user's room content with
 * nothing legitimate to cache it for.
 *
 * Locks are keyed rather than counted so two independent reasons can never
 * release each other's hold, and the state is in-memory (per tab) because that
 * is the scope a canvas has.
 */

export type LocalScenePersistenceLock =
  /** A room owns this canvas and no owned scene backs it (a guest). */
  | "collaboration-guest-canvas"
  /** Sign-out is clearing the canvas and must not let unload write it back. */
  | "sign-out";

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

/**
 * Checked synchronously on the `onChange` path, so it must stay a memory read —
 * no storage access, no allocation.
 */
export function isLocalScenePersistencePaused(): boolean {
  return locks.size > 0;
}
