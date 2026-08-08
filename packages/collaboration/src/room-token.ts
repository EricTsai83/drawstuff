import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { RoomId } from "./messages.ts";
import {
  joinTokenClaimsSchema,
  MAX_CONTROL_TOKEN_TTL_SECONDS,
  MAX_JOIN_TOKEN_TTL_SECONDS,
  MAX_ROOM_TOKEN_BYTES,
  roomControlClaimsSchema,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_CLOCK_SKEW_SECONDS,
  type JoinTokenClaims,
  type RoomControlClaims,
} from "./room-auth.ts";

/**
 * SERVER ONLY. This is the single module that touches the room token signing
 * secret, so it must never be imported from browser or client-component code:
 * clients receive a finished token from the app backend and hand it to the
 * relay. `./room-auth.ts` holds the claim contract and is safe everywhere.
 *
 * Token format: `<base64url(claims JSON)>.<base64url(HMAC-SHA256(payload))>`.
 * A compact self-contained token keeps the relay's join path synchronous and
 * free of any app or database dependency.
 */

/** 256-bit minimum for an HMAC-SHA256 key. */
export const MIN_ROOM_TOKEN_SECRET_BYTES = 32;

const encoder = new TextEncoder();

/**
 * Validates a signing secret. Exported so a service can fail at startup: the
 * verify path runs inside a socket message handler, where throwing would take
 * the process down instead of refusing one connection.
 */
export function assertRoomTokenSecret(secret: string): void {
  if (encoder.encode(secret).byteLength < MIN_ROOM_TOKEN_SECRET_BYTES) {
    throw new Error(
      `Room token secret must be at least ${MIN_ROOM_TOKEN_SECRET_BYTES} bytes`,
    );
  }
}

const signPayload = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const encodeToken = (claims: unknown, secret: string): string => {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const token = `${payload}.${signPayload(payload, secret)}`;
  if (encoder.encode(token).byteLength > MAX_ROOM_TOKEN_BYTES) {
    throw new Error("Room token exceeds the maximum token size");
  }
  return token;
};

/** Opaque token id; unique per issued token and safe to log. */
export function createRoomTokenId(): string {
  return randomUUID().replaceAll("-", "");
}

export function signJoinToken(claims: JoinTokenClaims, secret: string): string {
  assertRoomTokenSecret(secret);
  return encodeToken(joinTokenClaimsSchema.parse(claims), secret);
}

export function signRoomControlToken(
  claims: RoomControlClaims,
  secret: string,
): string {
  assertRoomTokenSecret(secret);
  return encodeToken(roomControlClaimsSchema.parse(claims), secret);
}

export type RoomTokenFailureReason =
  /** Larger than `MAX_ROOM_TOKEN_BYTES`; rejected before any parsing. */
  | "oversize"
  /** Not two base64url segments, or the payload is not JSON. */
  | "malformed"
  | "bad-signature"
  /** Signature is valid but the claim set is not (version, shape, TTL). */
  | "invalid-claims"
  | "wrong-audience"
  | "expired"
  /** Issued in the future beyond the allowed clock skew. */
  | "not-yet-valid"
  | "wrong-room";

export type RoomTokenVerification<Claims> =
  { ok: true; claims: Claims } | { ok: false; reason: RoomTokenFailureReason };

/**
 * Verifies the signature before the payload is parsed, so unauthenticated
 * bytes never reach the schema layer.
 */
function verifySignedPayload(
  token: string,
  secret: string,
): RoomTokenVerification<unknown> {
  assertRoomTokenSecret(secret);
  if (encoder.encode(token).byteLength > MAX_ROOM_TOKEN_BYTES) {
    return { ok: false, reason: "oversize" };
  }
  const separator = token.indexOf(".");
  // Exactly two segments: a payload and its signature.
  if (separator <= 0 || token.includes(".", separator + 1)) {
    return { ok: false, reason: "malformed" };
  }
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = signPayload(payload, secret);
  const received = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  // timingSafeEqual throws on a length mismatch, which is itself public
  // information (the digest length is fixed), so compare lengths first.
  if (
    received.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(received, expectedBytes)
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, claims: raw };
}

const checkLifetime = (
  claims: { iat: number; exp: number },
  nowSeconds: number,
  maxTtlSeconds: number,
): RoomTokenFailureReason | undefined => {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxTtlSeconds) {
    return "invalid-claims";
  }
  if (nowSeconds + ROOM_TOKEN_CLOCK_SKEW_SECONDS < claims.iat) {
    return "not-yet-valid";
  }
  if (nowSeconds - ROOM_TOKEN_CLOCK_SKEW_SECONDS >= claims.exp) {
    return "expired";
  }
  return undefined;
};

/**
 * Full join-token check: signature, format version, audience, lifetime, and
 * the binding to the room the handshake declares. The authorization
 * generation is never declared on the wire — the relay derives its routing
 * key from the verified `gen` claim, so a client cannot steer a token into
 * another generation's channel.
 *
 * Signature validity alone does not authorize a join: a token issued before a
 * revocation is still correctly signed, so the caller must also check it
 * against the revocation cutoffs recorded by the control endpoint.
 */
export function verifyJoinToken(options: {
  token: string;
  secret: string;
  /** Epoch seconds. */
  nowSeconds: number;
  expectedRoomId: RoomId;
}): RoomTokenVerification<JoinTokenClaims> {
  const signed = verifySignedPayload(options.token, options.secret);
  if (!signed.ok) return signed;

  const parsed = joinTokenClaimsSchema.safeParse(signed.claims);
  if (!parsed.success) {
    const audience =
      typeof signed.claims === "object" &&
      signed.claims !== null &&
      "aud" in signed.claims
        ? signed.claims.aud
        : undefined;
    return {
      ok: false,
      reason:
        audience !== undefined && audience !== ROOM_TOKEN_AUDIENCES.join
          ? "wrong-audience"
          : "invalid-claims",
    };
  }
  const claims = parsed.data;

  const lifetimeFailure = checkLifetime(
    claims,
    options.nowSeconds,
    MAX_JOIN_TOKEN_TTL_SECONDS,
  );
  if (lifetimeFailure) return { ok: false, reason: lifetimeFailure };

  if (claims.rid !== options.expectedRoomId) {
    return { ok: false, reason: "wrong-room" };
  }
  return { ok: true, claims };
}

/**
 * Control-token check. Replay is bounded by the short TTL rather than by
 * server-side token state: both control actions (revoking a member, ending a
 * room generation) are idempotent, so a replay within the TTL closes sockets
 * that are already gone.
 */
export function verifyRoomControlToken(options: {
  token: string;
  secret: string;
  nowSeconds: number;
}): RoomTokenVerification<RoomControlClaims> {
  const signed = verifySignedPayload(options.token, options.secret);
  if (!signed.ok) return signed;

  const parsed = roomControlClaimsSchema.safeParse(signed.claims);
  if (!parsed.success) {
    const audience =
      typeof signed.claims === "object" &&
      signed.claims !== null &&
      "aud" in signed.claims
        ? signed.claims.aud
        : undefined;
    return {
      ok: false,
      reason:
        audience !== undefined && audience !== ROOM_TOKEN_AUDIENCES.control
          ? "wrong-audience"
          : "invalid-claims",
    };
  }

  const lifetimeFailure = checkLifetime(
    parsed.data,
    options.nowSeconds,
    MAX_CONTROL_TOKEN_TTL_SECONDS,
  );
  if (lifetimeFailure) return { ok: false, reason: lifetimeFailure };

  return { ok: true, claims: parsed.data };
}
