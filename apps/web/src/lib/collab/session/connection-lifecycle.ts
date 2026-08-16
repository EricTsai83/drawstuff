import type { RoomId } from "@drawstuff/collaboration/protocol";
import type {
  createRecoveryMachine,
  RecoveryState,
  UnrecoverableReason,
} from "@drawstuff/collaboration/recovery";
import type {
  CollaborationTransport,
  DisconnectReason,
} from "@drawstuff/collaboration/transport";

/**
 * Credentials for one connection attempt.
 *
 * `authGeneration` travels with the token because it is what binds the token to
 * the key this session derived. If the owner rotates the generation while a
 * session is running, the next token comes back on the new generation — and the
 * session must stop rather than reconnect, because its derived key can no longer
 * open the room's ciphertext.
 */
export type JoinCredentials = {
  token: string;
  authGeneration: number;
};

/**
 * Why the backend would not issue credentials, and what recovery does about it.
 *
 * The classification is the caller's, not this module's: the backend's own error
 * vocabulary (an HTTP status, a tRPC code) is what distinguishes "you are no
 * longer in this room" from "the request did not get through", and the session
 * must not have to interpret transport errors to tell those apart. Getting the
 * split wrong in either direction is a real failure — retrying a revocation hides
 * it, and stopping on a blip abandons a session that was coming back.
 *
 * This is the authoritative split, not the relay's close code. The relay closes a
 * socket the moment the app withdraws its authorization, and it uses the same
 * code whether the member was removed or merely had their role changed — a role
 * change *requires* a reconnect, because the role travels in the token. Only the
 * next token request can distinguish them, so the terminal reasons live here.
 */
export type JoinCredentialsRefusal =
  /**
   * Transport or backend failure of unknown cause; retried with backoff.
   *
   * `retryAfterMs` is present when the backend named a deadline — today only a
   * rate limit does. It raises the recovery backoff for that one attempt and
   * never lowers it, and it does not grant an extra attempt: a rate limit is
   * transient, not terminal, so the existing bounded budget is what stops a
   * client that keeps being refused.
   */
  | { retry: true; retryAfterMs?: number }
  /** Terminal, with the reason to report. */
  | {
      retry: false;
      failure: Extract<
        UnrecoverableReason,
        "unauthorized" | "membership-revoked" | "room-ended"
      >;
    };

export type JoinCredentialsResult =
  ({ ok: true } & JoinCredentials) | ({ ok: false } & JoinCredentialsRefusal);

export type ConnectionLifecycle = {
  /** Opens a socket with the credentials already in hand. */
  beginAttempt(): void;
  /**
   * Applies the recovery policy to a lost connection: schedule the next attempt,
   * stop with a stated reason, or ignore it because we asked for it.
   */
  handleConnectionLoss(reason: DisconnectReason, notBeforeMs?: number): void;
  /** The single terminal teardown; every path that ends recovery goes through it. */
  terminate(): void;
  failRecovery(reason: UnrecoverableReason): void;
  notifyRecovery(): void;
  clearReconnectTimer(): void;
  /** Invalidates an in-flight token refresh; `disconnect()`/`destroy()`. */
  abandonInFlightAttempt(): void;
};

/**
 * Connection attempts and their credentials: the first socket, every reconnect,
 * the backoff timer between them, and the terminal teardown.
 */
export const createConnectionLifecycle = (options: {
  transport: Pick<CollaborationTransport, "connect" | "disconnect">;
  roomId: RoomId;
  /**
   * The room's durable authorization generation this session's keys are derived
   * from. Compared against every refreshed token so a rotation is detected as a
   * rotation instead of as a stream of undecryptable frames.
   */
  authGeneration: number;
  /** Short-lived join token already minted for the first attempt. */
  initialToken: string;
  /**
   * Mints credentials for a reconnect attempt. Join tokens are short-lived by
   * design, so the token that opened the first socket is usually expired by the
   * time a reconnect happens — and re-asking the backend is also what makes a
   * revoked member's reconnect fail where it should, at authorization time.
   */
  refreshJoinToken(): Promise<JoinCredentialsResult>;
  recovery: ReturnType<typeof createRecoveryMachine>;
  scheduleTimeout(run: () => void, delayMs: number): () => void;
  isDestroyed(): boolean;
  isTerminated(): boolean;
  /** Flips the orchestrator's terminal flag; `terminate()` is what sets it. */
  markTerminated(): void;
  /**
   * Everything beyond this module that a terminal state must stop: pending
   * flushes and timers, the epochs, the transport subscription and socket, the
   * barrier, the offline queue, and the peers' cursors on the canvas.
   */
  teardown(): void;
  onRecoveryStateChange?: (state: RecoveryState) => void;
}): ConnectionLifecycle => {
  const { transport, recovery } = options;

  /** Credentials for the current attempt; replaced by every refresh. */
  let credentials: JoinCredentials = {
    token: options.initialToken,
    authGeneration: options.authGeneration,
  };
  let cancelReconnectTimer: (() => void) | undefined;
  /**
   * Invalidates an in-flight token refresh. A refresh that settles after the
   * caller disconnected — or after a later attempt superseded it — must not open
   * a socket nobody asked for.
   */
  let attemptEpoch = 0;

  const notifyRecovery = (): void => {
    options.onRecoveryStateChange?.(recovery.state());
  };

  const clearReconnectTimer = (): void => {
    cancelReconnectTimer?.();
    cancelReconnectTimer = undefined;
  };

  /**
   * Being terminal is not just a label on the state machine: the session stops
   * doing work. It drops the connection (a socket held open in this condition
   * looks connected while syncing nothing), abandons any token refresh still in
   * flight, and hands everything else to the orchestrator's teardown — the
   * caller still holds a live session object and will keep sending `onChange`
   * until it tears it down.
   */
  const terminate = (): void => {
    options.markTerminated();
    clearReconnectTimer();
    // Abandons any token refresh still in flight for this session.
    attemptEpoch += 1;
    options.teardown();
  };

  const failRecovery = (reason: UnrecoverableReason): void => {
    recovery.fail(reason);
    terminate();
    notifyRecovery();
  };

  const handleConnectionLoss = (
    reason: DisconnectReason,
    /**
     * A server-stated deadline the next attempt must not precede. Raises the
     * recovery machine's own backoff; never lowers it, and never changes how
     * many attempts remain.
     */
    notBeforeMs = 0,
  ): void => {
    const next = recovery.lost(reason);
    if (next.phase === "failed") {
      // A terminal reason reported by the transport takes the same teardown as
      // any other, rather than only flipping the state machine and leaving the
      // session's timers, queue and subscription running.
      terminate();
      notifyRecovery();
      return;
    }
    notifyRecovery();
    if (next.phase !== "waiting") return;
    clearReconnectTimer();
    cancelReconnectTimer = options.scheduleTimeout(
      () => {
        cancelReconnectTimer = undefined;
        if (options.isDestroyed() || options.isTerminated()) return;
        reconnect();
      },
      Math.max(next.delayMs, notBeforeMs),
    );
  };

  /**
   * Mints fresh credentials and reconnects.
   *
   * The token is refreshed rather than reused because join tokens are
   * short-lived, and because re-asking the backend is what makes a reconnect fail
   * where it should: a member removed while offline is refused here, not left
   * looping against the relay.
   */
  const reconnect = (): void => {
    const epoch = (attemptEpoch += 1);
    recovery.start();
    notifyRecovery();
    void (async () => {
      let refreshed: JoinCredentialsResult;
      try {
        refreshed = await options.refreshJoinToken();
      } catch {
        // An unexpected throw is not evidence of lost access — a fetch that
        // never left the machine looks exactly like this — so it is retried.
        refreshed = { ok: false, retry: true };
      }
      if (options.isDestroyed() || epoch !== attemptEpoch) return;
      if (!refreshed.ok) {
        // The backend is the authority on whether this client may still be in the
        // room, so its refusal is what ends recovery — including for a member the
        // relay closed as "revoked", which is also how a role change arrives.
        if (!refreshed.retry) {
          failRecovery(refreshed.failure);
          return;
        }
        handleConnectionLoss("transient", refreshed.retryAfterMs);
        return;
      }
      // The room's generation moved under us, so this session's derived keys can
      // no longer open the room. Reconnecting would produce a client that is
      // connected and permanently blind; a new link is the only fix.
      if (refreshed.authGeneration !== options.authGeneration) {
        failRecovery("generation-rotated");
        return;
      }
      credentials = {
        token: refreshed.token,
        authGeneration: refreshed.authGeneration,
      };
      transport.connect({
        roomId: options.roomId,
        joinToken: credentials.token,
      });
    })();
  };

  return {
    beginAttempt() {
      recovery.start();
      notifyRecovery();
      transport.connect({
        roomId: options.roomId,
        joinToken: credentials.token,
      });
    },
    handleConnectionLoss,
    terminate,
    failRecovery,
    notifyRecovery,
    clearReconnectTimer,
    abandonInFlightAttempt() {
      clearReconnectTimer();
      attemptEpoch += 1;
    },
  };
};
