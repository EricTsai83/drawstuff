/**
 * Per-room connection limits enforced by the Durable Object room runtime.
 *
 * These values are internal safety and abuse bounds, not supported-capacity
 * promises. They live in this package — the workspace both the web client
 * and the room runtime depend on — next to the wire protocol whose close
 * codes expose them (`roomAtCapacity`, `joinTimeout`, `idleTimeout`,
 * `slowConsumer`).
 *
 * Deliberately *not* here: host-wide caps and the Durable Object's own
 * pending/total socket caps. Those bound a *host*, not a room, and each host
 * owns its own capacity envelope.
 */

/** Conservative safety bound; joins beyond it are refused (`roomAtCapacity`). */
export const MAX_CONNECTIONS_PER_ROOM = 32;

/** A socket that has not sent a valid join within this deadline is closed. */
export const ROOM_JOIN_TIMEOUT_MS = 10_000;

/**
 * A joined socket that sends no data frame for this long is closed.
 *
 * Distinct from liveness (heartbeat or keepalive), which only establishes that
 * the socket is alive. A forgotten tab stays alive indefinitely while holding
 * a room slot, so liveness alone is not evidence the session is still in use.
 */
export const ROOM_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * Slow-consumer cutoff: when a socket's outbound buffer exceeds this while a
 * session-ordered frame must be delivered, the socket is closed instead of
 * queueing without bound. The client reconnects and heals via `scene-init`
 * snapshots.
 */
export const MAX_SOCKET_BUFFERED_BYTES = 4 * 1_048_576;

/** Presence frames are dropped (never queued) above this buffer level. */
export const PRESENCE_DROP_BUFFERED_BYTES = 262_144;
