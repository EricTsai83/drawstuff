import { TRPCClientError } from "@trpc/client";

import type { JoinCredentialsResult } from "@/lib/collab/collaboration-session";
import { rateLimitRetryAfterMs } from "@/lib/collab/rate-limit";

/**
 * Turns a failed `collaborationRoom.join` into the credential refusal recovery
 * acts on.
 *
 * This is the only place that can make the call. The relay closes a socket as soon
 * as the app withdraws the authorization it holds, and it uses one close code for
 * both "removed from the room" and "role changed" — and a role change *must*
 * reconnect, because the role travels in the token. So the relay's close is always
 * retried, and this request is where a client that genuinely cannot come back is
 * stopped.
 *
 * Read off the tRPC error code rather than the message, and deliberately
 * conservative: only the codes that state a refusal are terminal, so an
 * unrecognized failure is retried. A retried refusal costs one round-trip and
 * lands here again; a terminal verdict on a transient failure would abandon a
 * session that was coming back.
 *
 * `PRECONDITION_FAILED` is `accessError`'s answer for a room that has ended or
 * expired, which is exactly why it must not read as "unavailable": retrying it
 * would spend the whole budget and then report the wrong reason.
 */
export function classifyJoinFailure(error: unknown): JoinCredentialsResult {
  const code =
    error instanceof TRPCClientError
      ? (error.data as { code?: unknown } | null | undefined)?.code
      : undefined;
  switch (code) {
    case "FORBIDDEN":
      return { ok: false, retry: false, failure: "membership-revoked" };
    case "UNAUTHORIZED":
      return { ok: false, retry: false, failure: "unauthorized" };
    case "PRECONDITION_FAILED":
    case "NOT_FOUND":
      return { ok: false, retry: false, failure: "room-ended" };
    // Over the shared join budget. Transient by construction, so it takes the
    // retry path — but with the server's own reset time attached, because
    // retrying inside the window would spend the very budget being waited on
    // and push the deadline out. The deadline is read off `data.rateLimit`,
    // never off the message.
    case "TOO_MANY_REQUESTS":
      return {
        ok: false,
        retry: true,
        retryAfterMs: rateLimitRetryAfterMs(error) ?? undefined,
      };
    default:
      return { ok: false, retry: true };
  }
}

/** Bootstrap join attempts, counting the first. */
export const MAX_INITIAL_JOIN_ATTEMPTS = 3;

export type BootstrapJoinOutcome<T> =
  | { status: "joined"; value: T }
  /** Torn down mid-wait; the caller must not touch state. */
  | { status: "cancelled" }
  /** Still refused after the bounded wait; nothing was joined. */
  | { status: "rate-limited" };

/**
 * Runs the *first* join, waiting out a rate limit instead of reporting one.
 *
 * `classifyJoinFailure` above covers reconnects, which is only half the story:
 * the bootstrap join has no session yet, so its failure lands in the effect's
 * catch-all and used to be reported as `unauthorized` — terminal, and wrong.
 * Nothing about being over a shared budget says this client may not be here.
 *
 * Three properties make this safe to retry where a blanket retry would not be:
 *
 * - **Only a rate limit.** The deadline has to be machine-readable on the
 *   error; anything else is rethrown untouched, so an authorization refusal
 *   reaches the existing handler exactly as before and never becomes a loop.
 * - **Never early.** The wait is the server's own `retryAfterMs`. Retrying
 *   inside the window spends the budget being waited on and pushes the deadline
 *   further out.
 * - **Bounded and cancellable.** Three attempts, and `isCancelled` is consulted
 *   before every one — including immediately after a wait — so a component torn
 *   down mid-window issues no further mutation.
 *
 * It deliberately retries only the join call. Re-running the whole bootstrap
 * would re-prompt for the canvas the user already gave up.
 */
export async function joinWithRateLimitRetry<T>(options: {
  attempt: () => Promise<T>;
  isCancelled: () => boolean;
  /** Resolves after `ms`, or early when the caller is torn down. */
  wait: (ms: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<BootstrapJoinOutcome<T>> {
  const maxAttempts = options.maxAttempts ?? MAX_INITIAL_JOIN_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.isCancelled()) return { status: "cancelled" };
    try {
      return { status: "joined", value: await options.attempt() };
    } catch (error) {
      const retryAfterMs = rateLimitRetryAfterMs(error);
      if (retryAfterMs === null) throw error;
      if (attempt === maxAttempts) break;
      await options.wait(retryAfterMs);
    }
  }
  return options.isCancelled()
    ? { status: "cancelled" }
    : { status: "rate-limited" };
}
