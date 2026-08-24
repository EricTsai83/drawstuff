import { KEEPALIVE_INTERVAL_MS } from "@drawstuff/collaboration/client-pacing";
import {
  DEFAULT_RELAY_RATE_LIMITS,
  maxFullRefillMs,
} from "@drawstuff/collaboration/rate-limit";
import {
  MAX_SOCKET_BUFFERED_BYTES,
  PRESENCE_DROP_BUFFERED_BYTES,
} from "@drawstuff/collaboration/room-limits";

/**
 * Durable-Object-specific room policy: the caps, quanta and pure decision
 * helpers that have no Node-relay counterpart. The shared per-room limits
 * (internal member safety cap, join/idle deadlines, buffer budgets) come from
 * `@drawstuff/collaboration/room-limits`. The cap bounds abuse and resource
 * use; it is not a supported-concurrency promise.
 */

/**
 * Upper bound on sockets that are accepted but not yet joined. Sized to one
 * full room's worth of clients re-authenticating at once while preventing an
 * unauthenticated flood from holding unbounded sockets open for the 10 s join
 * deadline. This is a conservative internal safety limit and must never lean
 * on the platform's much larger connection ceiling.
 */
export const MAX_PENDING_SOCKETS = 32;

/**
 * Hard cap on sockets attached to one Object in any state: the joined safety
 * cap plus the pending safety cap. It does not describe verified capacity.
 */
export const MAX_ROOM_SOCKETS = 64;

/**
 * How far the persisted `lastFrameAt` may lag the live value before the
 * attachment is rewritten.
 *
 * `serializeAttachment()` persists the whole attachment, so rewriting it per
 * frame at 32 sockets x up to 120 Hz would be pure serialization/storage
 * amplification with no correctness gain. Instead a data frame only rewrites
 * the attachment when the persisted value has fallen this far behind. Every
 * deadline that reads `lastFrameAt` adds this quantum, so the error is bounded
 * by it, one-directional (a close can only be late, never early) and
 * negligible against the 15-minute idle budget (~3%). Thirty seconds also
 * bounds the write rate to at most two attachment writes per socket per
 * minute under sustained fanout.
 */
export const LAST_FRAME_PERSIST_QUANTUM_MS = 30_000;

/**
 * A joined socket with no liveness evidence — accepted data frame, keepalive
 * auto-response, or the join itself — older than this is treated as dead.
 *
 * Replaces the relay's server-initiated ping (15 s cadence, one missed pong
 * terminates, ≈30 s detection), which cannot be ported: waking the Object per
 * ping defeats hibernation. Two missed client keepalives plus scheduling
 * slack keeps the detection bound in the same order of magnitude. Checked
 * lazily only (any alarm that fires, a failed fanout write, a join against a
 * full room) — never by a dedicated high-frequency alarm, which would defeat
 * hibernation just as surely as pings.
 *
 * Callers must add `LAST_FRAME_PERSIST_QUANTUM_MS` when judging from the
 * persisted `lastFrameAt`, so a socket whose only staleness is the lazy
 * attachment write is never reaped early. The client-visible dead-peer bound
 * is therefore `ROOM_LIVENESS_TIMEOUT_MS + LAST_FRAME_PERSIST_QUANTUM_MS`
 * plus the delay until the next lazy check — documented in
 * `docs/performance/collaboration-slo-capacity.md`.
 */
export const ROOM_LIVENESS_TIMEOUT_MS = 2 * KEEPALIVE_INTERVAL_MS + 5_000;

/**
 * The one sanctioned exception to "in-memory state is never authority": the
 * per-connection rate buckets are rebuilt *full* after hibernation, eviction
 * or a code update. That reconstruction is behaviorally equivalent to having
 * persisted them because workerd only hibernates an Object after roughly this
 * long without events, and every default bucket refills completely within it
 * (asserted below, and pinned by the shared rate-limit contract test). An
 * eviction or code update that interrupts a mid-burst sender can hand it at
 * most one extra bucket of budget — a bounded admission-control error that
 * touches no membership state.
 */
const HIBERNATION_MIN_IDLE_MS = 10_000;

if (maxFullRefillMs(DEFAULT_RELAY_RATE_LIMITS) > HIBERNATION_MIN_IDLE_MS) {
  throw new Error(
    "Rate budgets must refill within the hibernation idle threshold; " +
      "a full-bucket rebuild after hibernation would otherwise grant budget " +
      "that persistence would not have",
  );
}

/** What the fanout does with one frame for one receiver. */
export type FanoutDeliveryAction =
  "send" | "drop-presence" | "close-slow-consumer";

/**
 * Reads the receiver's outbound buffer occupancy when the host exposes it.
 *
 * workerd's server-side WebSocket type does not declare `bufferedAmount`
 * (browser sockets do), so this probes the live object instead of trusting
 * the type surface. When the host omits the signal, sends remain best-effort:
 * host write failures close only that receiver. We do not claim an
 * application-level slow-consumer byte threshold on such a host.
 */
export function socketBufferedAmount(ws: WebSocket): number | undefined {
  const value = (ws as unknown as { bufferedAmount?: unknown }).bufferedAmount;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Backpressure policy per receiver, identical to the relay's: presence is
 * volatile (latest-wins per sender), so under backpressure a sample is
 * dropped and repaired by the next one; scene is session-ordered, so a
 * receiver that stops draining must be disconnected rather than queued to
 * without bound — the client reconnects and heals via `scene-init` snapshots.
 *
 * An *unknown* buffer level (`undefined`) delivers: absence of the signal is
 * not evidence of backpressure, and refusing to deliver on a host that never
 * reports the value would silently break fanout. Pure, so the policy is
 * unit-testable in workerd regardless of what the host exposes.
 */
export function fanoutDeliveryAction(
  channel: "scene" | "presence",
  bufferedAmount: number | undefined,
): FanoutDeliveryAction {
  if (bufferedAmount === undefined) return "send";
  if (channel === "presence") {
    return bufferedAmount > PRESENCE_DROP_BUFFERED_BYTES
      ? "drop-presence"
      : "send";
  }
  return bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
    ? "close-slow-consumer"
    : "send";
}
