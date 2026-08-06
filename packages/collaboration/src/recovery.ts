import type { DisconnectReason } from "./transport.ts";

/**
 * Connection recovery state machine.
 *
 * A collaboration session has more states than "connected" and "not connected",
 * and conflating them is what makes reconnection go wrong. A socket that is open
 * but still waiting for its baseline must not publish the canvas; a session that
 * lost its socket must retry, but a session whose membership was revoked must
 * not; and a client that keeps retrying instantly is indistinguishable from an
 * attack on the relay. So the phases are named, the legal transitions are
 * enumerated, and every terminal state is a stated reason rather than "we
 * stopped trying".
 *
 * This module is pure: it holds no timer, no socket, and no scene. It answers
 * "what phase am I in" and "how long until the next attempt", and the caller
 * (the collaboration session) owns the transport and the clock. That is what
 * makes the whole recovery path testable without wall time.
 *
 * ## Phases
 *
 * ```
 *                  start()                  connected()
 *   idle ─────────────────────► connecting ─────────────► syncing
 *    ▲                            │  ▲                       │
 *    │ stop()                     │  │ start()               │ synced()
 *    │                            │  │                       ▼
 *    └──────────── any ◄──────────┘  └──── waiting ◄──────── live
 *                                              ▲   lost("transient")
 *                                              │
 *                       lost(terminal reason) ─┴─► failed  (no exit)
 * ```
 *
 * `syncing` is not cosmetic: it is the window in which the join barrier holds
 * inbound traffic and the canvas is not yet the room's scene. Reaching `live`
 * requires the baseline to have resolved, which is also what resets the retry
 * budget — a connection that opens and dies before syncing is not progress, and
 * counting it as such would turn a crash-looping relay into an unbounded retry
 * loop at the fastest possible cadence.
 */

/**
 * Why recovery stopped for good. Every one of these is reported to the user:
 * a session that silently stops reconnecting looks identical to one that is
 * merely slow, and the difference matters — one is waiting, the other needs the
 * user to obtain a new link, ask for access, or reload.
 */
export type UnrecoverableReason =
  /** The app backend refused to issue a join token, or the relay refused it. */
  | "unauthorized"
  /** This member's room authorization was revoked. */
  | "membership-revoked"
  /** The room generation was ended or rotated by its owner. */
  | "room-ended"
  /**
   * The room's authorization generation moved while this session was running, so
   * the key this client derived can no longer open the room's ciphertext. A new
   * link is required; reconnecting with the same key would produce a session
   * that can neither read nor write.
   */
  | "generation-rotated"
  /**
   * This client cannot decrypt the room — a link carrying the wrong key.
   * Terminal because snapshot, realtime and asset ciphertext are all sealed under
   * keys derived from the same material, so the session would sit connected and
   * permanently blind.
   *
   * Two independent detectors reach it, and both are needed: the stored snapshot
   * failing to open, and every realtime frame that arrives failing to open while
   * none ever has (`TransportSubscriber.onRoomUnreadable`). The snapshot is the
   * faster and more certain oracle, but a room that has not been persisted yet
   * does not have one at all — and that is precisely the room where a silent
   * failure lasts forever.
   */
  | "unreadable-room"
  /** A wire-contract violation; reconnecting would repeat it. */
  | "protocol-violation"
  /**
   * This session's end-to-end nonce budget is spent. Reconnecting does not
   * refresh it — the key is derived per room generation, not per session — so the
   * room generation has to be rotated.
   */
  | "crypto-exhausted"
  /** The retry budget is spent; the room did not come back. */
  | "retry-limit";

export type RecoveryState =
  /** Not connected and not trying: before `start()` and after `stop()`. */
  | { readonly phase: "idle" }
  /** A connection attempt is in flight (token request included). */
  | { readonly phase: "connecting"; readonly attempt: number }
  /** Socket joined; the join baseline has not resolved yet. */
  | { readonly phase: "syncing"; readonly attempt: number }
  /** Joined and synced: the canvas is the room's scene. */
  | { readonly phase: "live" }
  /** Backing off before the next attempt. */
  | {
      readonly phase: "waiting";
      /** Number the *upcoming* attempt will have; the delay is sized for it. */
      readonly attempt: number;
      /** Delay the caller must wait before calling `start()`. */
      readonly delayMs: number;
    }
  /** Terminal. */
  | { readonly phase: "failed"; readonly reason: UnrecoverableReason };

/**
 * First backoff delay. Short enough that the common case — a transient socket
 * failure — reconnects before the user finishes noticing.
 */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;

/**
 * Backoff ceiling. Past this, waiting longer only makes a recovered room feel
 * broken; the attempt budget, not the delay, is what ends a hopeless retry loop.
 */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Consecutive failed attempts before recovery gives up. With the delays above
 * this spans roughly three minutes of trying, which covers a relay deploy and
 * still ends in an explicit error rather than an invisible forever-retry.
 */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

export type RecoveryPolicyOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  /**
   * Jitter source, injectable so the fault-injection suite runs on a seeded
   * generator instead of `Math.random`.
   */
  random?: () => number;
};

/**
 * Equal-jitter exponential backoff: half the computed delay, plus a random
 * portion of the other half.
 *
 * Full jitter (`random × delay`) is the more common recipe, but it can return
 * ~0ms, which turns the first retry of a room-wide outage into a thundering herd
 * against a relay that has just come back. Keeping half the delay as a floor
 * preserves the spread that matters — ten clients reconnecting do not land in the
 * same millisecond — while guaranteeing the relay gets a breathing gap.
 */
export function reconnectDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
}): number {
  const { attempt, baseDelayMs, maxDelayMs, random } = params;
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  const half = capped / 2;
  return Math.round(half + random() * half);
}

/**
 * What a disconnect means for recovery. Split out from the machine so the
 * mapping is testable on its own and so a caller can explain a disconnect
 * without driving a state machine to find out.
 */
export type DisconnectVerdict =
  /** Schedule another attempt, subject to the retry budget. */
  | { readonly action: "retry" }
  /** Recovery is over; report this reason. */
  | { readonly action: "stop"; readonly failure: UnrecoverableReason }
  /** The caller ended the session, so there is nothing to recover. */
  | { readonly action: "ignore" };

export function classifyDisconnect(
  reason: DisconnectReason,
): DisconnectVerdict {
  switch (reason) {
    case "transient":
    // A refused token is retryable because the usual cause is expiry: the next
    // attempt mints a fresh one.
    case "unauthorized":
    /**
     * Also retryable, which is not the obvious reading of the name.
     *
     * The relay closes with this code whenever the app withdraws the
     * authorization a live socket holds — and *changing* a member's role is one
     * of those. The role a socket carries came from its token, so the app
     * revokes the old authorization precisely in order to force a reconnect that
     * picks up the new role. A demoted editor and a removed member therefore
     * arrive as the same close code, and the close cannot tell them apart.
     *
     * The app backend can, on the next token request: a re-granted member is
     * issued a token at the bumped revision and reconnects, while a removed one
     * is refused there and recovery stops with a stated reason. Treating the
     * close itself as terminal would strand every role change in `failed`.
     */
    case "membership-revoked":
      return { action: "retry" };
    case "room-ended":
      return { action: "stop", failure: "room-ended" };
    case "protocol":
      return { action: "stop", failure: "protocol-violation" };
    case "idle":
      return { action: "ignore" };
  }
}

export interface RecoveryMachine {
  state(): RecoveryState;
  /**
   * Begins an attempt. Legal from `idle` and `waiting` only — the caller must
   * not start a second attempt while one is in flight, and a `failed` machine
   * never starts another.
   */
  start(): void;
  /** The socket joined the room. Legal from `connecting`. */
  connected(): void;
  /**
   * The join baseline resolved, so the session is live and the retry budget is
   * spent-free again. Legal from `syncing`.
   */
  synced(): void;
  /**
   * The connection ended. Returns the resulting state so the caller can act on
   * one value: `waiting` carries the delay to schedule, `failed` the reason to
   * report. Ignored (and reported as the current state) while `idle` or
   * `failed`, both of which are legitimately reachable — a transport emits its
   * final `disconnected` after the caller already stopped.
   */
  lost(reason: DisconnectReason): RecoveryState;
  /**
   * Terminates recovery for a reason the transport cannot express: a rotated
   * generation, an unreadable room, a spent nonce budget, or a backend that
   * refuses to authorize this client at all. Idempotent; the first reason wins,
   * because the first one is the cause and the rest are consequences.
   */
  fail(reason: UnrecoverableReason): RecoveryState;
  /** Back to `idle`, from any phase including `failed`. */
  stop(): void;
}

export function createRecoveryMachine(
  options: RecoveryPolicyOptions = {},
): RecoveryMachine {
  const {
    baseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
    maxAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    random = Math.random,
  } = options;
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs <= 0) {
    throw new Error(
      `baseDelayMs must be a positive integer, received ${baseDelayMs}`,
    );
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error(
      `maxDelayMs must be an integer of at least baseDelayMs (${baseDelayMs}), received ${maxDelayMs}`,
    );
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error(
      `maxAttempts must be a positive integer, received ${maxAttempts}`,
    );
  }

  let state: RecoveryState = { phase: "idle" };
  /** Consecutive attempts since the last time the session went `live`. */
  let attempt = 0;

  const illegal = (event: string): Error =>
    new Error(`recovery: ${event} is not legal in phase "${state.phase}"`);

  return {
    state: () => state,

    start() {
      if (state.phase !== "idle" && state.phase !== "waiting") {
        throw illegal("start()");
      }
      attempt += 1;
      state = { phase: "connecting", attempt };
    },

    connected() {
      if (state.phase !== "connecting") throw illegal("connected()");
      state = { phase: "syncing", attempt };
    },

    synced() {
      if (state.phase !== "syncing") throw illegal("synced()");
      // Progress, not merely a socket: only a resolved baseline clears the
      // budget, so a relay that accepts joins and drops them still backs off.
      attempt = 0;
      state = { phase: "live" };
    },

    lost(reason) {
      if (state.phase === "idle" || state.phase === "failed") return state;
      if (state.phase === "waiting") {
        throw illegal(`lost(${reason})`);
      }
      const verdict = classifyDisconnect(reason);
      if (verdict.action === "stop") {
        state = { phase: "failed", reason: verdict.failure };
        return state;
      }
      if (verdict.action === "ignore") {
        attempt = 0;
        state = { phase: "idle" };
        return state;
      }
      if (attempt >= maxAttempts) {
        state = { phase: "failed", reason: "retry-limit" };
        return state;
      }
      // `waiting` describes the attempt that is *about* to happen, not the one
      // that just failed: the delay before the first retry is the delay for
      // attempt 1, and reporting the failed attempt's number would back off one
      // step behind the attempt it is backing off for.
      const nextAttempt = attempt + 1;
      state = {
        phase: "waiting",
        attempt: nextAttempt,
        delayMs: reconnectDelayMs({
          attempt: nextAttempt,
          baseDelayMs,
          maxDelayMs,
          random,
        }),
      };
      return state;
    },

    fail(reason) {
      if (state.phase !== "failed") state = { phase: "failed", reason };
      return state;
    },

    stop() {
      attempt = 0;
      state = { phase: "idle" };
    },
  };
}
