/**
 * The wire contract for "you are over the collaboration rate limit", shared by
 * both backend entry points and by every client that has to react to one.
 *
 * There are two transports and they cannot be unified: tRPC carries a
 * `TOO_MANY_REQUESTS` error whose `data` this module's server half decorates,
 * and the UploadThing presign route carries a plain HTTP 429 with a JSON body.
 * What *is* unified is the payload — `reset` and `retryAfterMs` — and the rule
 * that a client reads those numbers rather than a human-readable message. A
 * message is for a person; a retry deadline is for a machine, and parsing one
 * out of the other is how a limiter turns into a permanent retry loop the first
 * time the wording changes.
 *
 * `retryAfterMs` is computed on the server from the same clock that produced
 * `reset`, so a client with a skewed clock still waits the right amount of
 * time. `reset` travels alongside it as the absolute statement, for a client
 * that needs to compare two responses.
 *
 * This module is deliberately dependency-free and client-safe: it is imported
 * by the browser bundle and by `src/server/rate-limit/collaboration.ts` alike.
 */

/** Stable app-owned discriminator; UploadThing 7.7.4 has no 429 error code. */
export const COLLAB_RATE_LIMITED_ERROR = "COLLAB_RATE_LIMITED";

export type CollaborationRateLimitMetadata = {
  /** Unix milliseconds at which the window resets. */
  reset: number;
  /** Milliseconds until `reset`, measured on the server's clock. Never negative. */
  retryAfterMs: number;
};

/** Body of the UploadThing presign route's 429. */
export type CollaborationRateLimitErrorBody = {
  error: typeof COLLAB_RATE_LIMITED_ERROR;
  /** Which budget was spent; an enum, never a caller-supplied string. */
  operation: string;
} & CollaborationRateLimitMetadata;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Reads the metadata out of whatever shape it arrived in.
 *
 * Handles all three: the decorated tRPC error `data`, the raw metadata object,
 * and the UploadThing error body (which the client library hands back as
 * `cause`, because it maps 429 to `INTERNAL_SERVER_ERROR` — the very reason the
 * body has to be self-describing).
 */
export function readRateLimitMetadata(
  value: unknown,
): CollaborationRateLimitMetadata | null {
  if (!isRecord(value)) return null;
  const { reset, retryAfterMs } = value;
  if (typeof reset !== "number" || typeof retryAfterMs !== "number")
    return null;
  if (!Number.isFinite(reset) || !Number.isFinite(retryAfterMs)) return null;
  return { reset, retryAfterMs: Math.max(0, retryAfterMs) };
}

/**
 * Classifies an arbitrary thrown value as "rate limited, retry after this long".
 *
 * Returns `null` for everything else, including failures that merely look
 * similar: the caller's existing classification — terminal authorization
 * refusals, oversize payloads, transport errors — is unchanged, and a rate
 * limit only ever *delays* a retry the caller was already going to make. The
 * caller's bounded retry budget still applies; nothing here grants extra
 * attempts.
 */
export function rateLimitRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) return null;
  // tRPC: `TRPCClientError.data.rateLimit`, set by the server's errorFormatter.
  const data = error.data;
  if (isRecord(data)) {
    const fromTrpc = readRateLimitMetadata(data.rateLimit);
    if (fromTrpc) return fromTrpc.retryAfterMs;
  }
  // UploadThing: the parsed 429 body arrives as the error's `cause`.
  const cause = error.cause;
  if (isRecord(cause) && cause.error === COLLAB_RATE_LIMITED_ERROR) {
    const fromBody = readRateLimitMetadata(cause);
    if (fromBody) return fromBody.retryAfterMs;
  }
  return null;
}
