/**
 * Client-side pacing contract.
 *
 * These constants state how fast a well-behaved client *sends*, and they are
 * the assumptions the room runtime's per-connection rate budgets
 * (`./rate-limit.ts`) are sized against. They live in this package — the one
 * workspace both the web client and the Durable Object room runtime depend
 * on — so a pacing change on the client side fails the budget contract test
 * instead of silently loosening or over-tightening the budgets (plan 07 L5).
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
 * Cadence at which a client sends the optional keepalive frame
 * (`RELAY_KEEPALIVE_REQUEST` in `./relay-protocol.ts`).
 *
 * Sizes the dead-peer detection bound: the Durable Object treats a joined
 * socket without keepalive (or data) evidence for 2×interval + scheduling
 * slack as dead. Client sending is wired up together with the Durable Object
 * transport; this constant sizes the Durable Object's liveness budget.
 */
export const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Fastest display refresh rate the budgets assume a client flushes at. Scene
 * flushes are paced by `requestAnimationFrame`, so a continuous drag sustains
 * one flush per display frame — ~60/s on a 60 Hz display and up to this on the
 * fastest displays the budgets plan for.
 */
export const MAX_EXPECTED_DISPLAY_REFRESH_HZ = 120;
