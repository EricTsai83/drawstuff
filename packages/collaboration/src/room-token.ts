import { createHmac, timingSafeEqual } from "node:crypto";

import { decodeBase64Url, encodeBase64Url } from "./base64.ts";
import {
  identityProofClaimsSchema,
  type IdentityProofClaims,
} from "./authority.ts";
import type { RoomId } from "./messages.ts";
import {
  MAX_IDENTITY_PROOF_TTL_SECONDS,
  MAX_ROOM_TOKEN_BYTES,
  ROOM_TOKEN_CLOCK_SKEW_SECONDS,
} from "./room-auth.ts";

/**
 * SERVER ONLY. This is the single module that touches the identity-proof
 * signing secret, so it must never be imported from browser or
 * client-component code: clients receive a finished proof from the app
 * backend and hand it to the room. The claim contract lives in
 * `./authority.ts` and `./room-auth.ts`, both safe everywhere.
 *
 * Token format: `<base64url(claims JSON)>.<base64url(HMAC-SHA256(payload))>`.
 * A compact self-contained token keeps the room's join path free of any app
 * or database dependency for the identity check.
 */

/** 256-bit minimum for an HMAC-SHA256 key. */
export const MIN_ROOM_TOKEN_SECRET_BYTES = 32;

const encoder = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF in the output (matching Node's
// `Buffer#toString("utf8")`), where `JSON.parse` then rejects it — the default
// decoder would strip it and silently widen the accepted payload format.
// `fatal` is the runtime default, spelled out because the workerd type
// dictionary makes both members required.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });

/** HMAC-SHA256 digest length; the only signature size a token can carry. */
const SIGNATURE_BYTES = 32;

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

const signPayload = (payload: string, secret: string): Uint8Array =>
  createHmac("sha256", secret).update(payload).digest();

const encodeToken = (claims: unknown, secret: string): string => {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const token = `${payload}.${encodeBase64Url(signPayload(payload, secret))}`;
  if (encoder.encode(token).byteLength > MAX_ROOM_TOKEN_BYTES) {
    throw new Error("Room token exceeds the maximum token size");
  }
  return token;
};

export function signIdentityProof(
  claims: IdentityProofClaims,
  secret: string,
): string {
  assertRoomTokenSecret(secret);
  return encodeToken(identityProofClaimsSchema.parse(claims), secret);
}

export function verifyIdentityProof(options: {
  token: string;
  secret: string;
  nowSeconds: number;
  expectedRoomId: RoomId;
}): RoomTokenVerification<IdentityProofClaims> {
  const signed = verifySignedPayload(options.token, options.secret);
  if (!signed.ok) return signed;
  const parsed = identityProofClaimsSchema.safeParse(signed.claims);
  if (!parsed.success) return { ok: false, reason: "invalid-claims" };
  const failure = checkLifetime(
    parsed.data,
    options.nowSeconds,
    MAX_IDENTITY_PROOF_TTL_SECONDS,
  );
  if (failure) return { ok: false, reason: failure };
  if (parsed.data.roomId !== options.expectedRoomId)
    return { ok: false, reason: "wrong-room" };
  return { ok: true, claims: parsed.data };
}

export type RoomTokenFailureReason =
  /** Larger than `MAX_ROOM_TOKEN_BYTES`; rejected before any parsing. */
  | "oversize"
  /** Not two base64url segments, or the payload is not JSON. */
  | "malformed"
  | "bad-signature"
  /** Signature is valid but the claim set is not (version, shape, TTL). */
  | "invalid-claims"
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
  // Canonical decode: a signature segment the signer could not have produced
  // (padding, whitespace, non-canonical bits) is just a bad signature.
  const received = decodeBase64Url(signature, { maxBytes: SIGNATURE_BYTES });
  if (!received.ok) return { ok: false, reason: "bad-signature" };
  const expectedBytes = signPayload(payload, secret);
  // timingSafeEqual throws on a length mismatch, which is itself public
  // information (the digest length is fixed), so compare lengths first.
  if (
    received.bytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(received.bytes, expectedBytes)
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  // The oversize gate above bounds the whole token, so the payload segment
  // can never decode past it.
  const payloadBytes = decodeBase64Url(payload, {
    maxBytes: MAX_ROOM_TOKEN_BYTES,
  });
  if (!payloadBytes.ok) return { ok: false, reason: "malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(payloadBytes.bytes)) as unknown;
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
