/**
 * Client-side pacing contract.
 *
 * These constants state how fast a well-behaved client *sends*, and they are
 * the assumptions the relay's per-connection rate budgets
 * (`apps/collaboration-relay/src/rate-limit.ts`) are sized against. They live
 * in this package — the one workspace both the web client and the relay
 * depend on — so a pacing change on the client side fails the relay's
 * budget contract test instead of silently loosening or over-tightening the
 * budgets (plan 07 L5).
 */

/**
 * Minimum interval between presence samples a client publishes (~30/s).
 * Mirrors the upstream collab app's `CURSOR_SYNC_TIMEOUT`.
 */
export const PRESENCE_THROTTLE_MS = 33;

/**
 * Longest scene-flush coalescing window when animation frames are throttled
 * (hidden tab): a plain timer backstop keeps outbound deltas moving. The flush
 * races this timer against `requestAnimationFrame` and takes whichever fires
 * first, so it is a *backstop* for a throttled tab, not a minimum interval.
 */
export const SCENE_FLUSH_BACKSTOP_MS = 32;

/**
 * Fastest display refresh rate the budgets assume a client flushes at. Scene
 * flushes are paced by `requestAnimationFrame`, so a continuous drag sustains
 * one flush per display frame — ~60/s on a 60 Hz display and up to this on the
 * fastest displays the budgets plan for.
 */
export const MAX_EXPECTED_DISPLAY_REFRESH_HZ = 120;
