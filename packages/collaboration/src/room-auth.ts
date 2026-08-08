import { z } from "zod";

import { roomIdSchema, type RoomId } from "./messages.ts";

/**
 * Room authorization contract shared by the Drawstuff app (the only token
 * issuer) and the relay (the only token verifier).
 *
 * Two deliberate exclusions:
 *
 * - No cryptography lives here, so this module stays safe to import from a
 *   browser bundle. HMAC signing and verification are in `./room-token.ts`,
 *   which is server-only.
 * - No encryption key material may ever appear in these claims. The relay is
 *   an authorization boundary, not a key distribution channel: end-to-end
 *   room keys stay between clients. `roomTokenClaimKeys` pins the claim sets
 *   so a future change cannot quietly add a key field.
 *
 * Authorization revocation and cryptographic revocation are different things.
 * Removing a member (or ending a room) stops new connections and new frames
 * immediately, but a client that already holds a room key can still read
 * ciphertext it captured earlier. Cryptographic revocation requires a new
 * room generation — see `roomChannelKey`.
 */

export const ROOM_ROLES = ["owner", "editor", "viewer"] as const;
export const roomRoleSchema = z.enum(ROOM_ROLES);
export type RoomRole = z.infer<typeof roomRoleSchema>;

/**
 * Viewers receive scene traffic but must never mutate the scene. The relay
 * enforces this on every inbound frame; the editor UI mirrors it as read-only
 * state, so the check exists on both sides and neither is load-bearing alone.
 */
export function roomRoleCanEditScene(role: RoomRole): boolean {
  return role === "owner" || role === "editor";
}

/**
 * Monotonic authorization revision of a room, advanced by the app under a row
 * lock on every membership or lifecycle change. Ordering revocations by a
 * revision rather than by a wall clock is what makes them exact: a request that
 * waits for the lock still produces a cutoff above every token issued before
 * it, and a token issued after a re-grant is always above that re-grant's
 * cutoff. Tokens carry the revision they were issued under; control actions
 * carry the revision they produced.
 */
export const roomAuthRevisionSchema = z.int().positive();

/**
 * Authorization generation of a room, assigned and stored by the app. It is
 * NOT the relay's `roomGeneration`: that one is a per-connection session epoch
 * the relay mints in memory so stale frames from an earlier socket
 * are rejected. This one is durable and only advances when the room's
 * authorization — and later its encryption key — must be invalidated.
 */
export const roomAuthGenerationSchema = z.int().positive();

/**
 * Relay routing key. Rooms are partitioned by authorization generation, so a
 * rotated room is a different channel by construction: a token minted for
 * generation N can never reach members of generation N+1, with no relay-side
 * revocation state required.
 */
export const roomChannelKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/)
  .brand<"RoomChannelKey">();
export type RoomChannelKey = z.infer<typeof roomChannelKeySchema>;

export function roomChannelKey(
  roomId: RoomId,
  authGeneration: number,
): RoomChannelKey {
  return roomChannelKeySchema.parse(
    `${roomId}-g${roomAuthGenerationSchema.parse(authGeneration)}`,
  );
}

/** Version of the room token format; bumped only on a breaking claim change. */
export const ROOM_TOKEN_VERSION = 1;

export const ROOM_TOKEN_AUDIENCES = {
  /** Presented by a client on the relay join handshake. */
  join: "drawstuff-relay-join",
  /** Presented by the app backend on the relay control endpoint. */
  control: "drawstuff-relay-control",
} as const;

/** Hard cap on a token string, applied before any parsing. */
export const MAX_ROOM_TOKEN_BYTES = 1_024;

/** Join tokens are short-lived so a leaked token expires on its own. */
export const DEFAULT_JOIN_TOKEN_TTL_SECONDS = 60;
/** Verifiers reject a longer TTL even if the issuer asks for one. */
export const MAX_JOIN_TOKEN_TTL_SECONDS = 300;
/** Control calls are backend-to-backend and complete immediately. */
export const DEFAULT_CONTROL_TOKEN_TTL_SECONDS = 30;
export const MAX_CONTROL_TOKEN_TTL_SECONDS = 60;

/** Small clock-skew allowance between the app and the relay. */
export const ROOM_TOKEN_CLOCK_SKEW_SECONDS = 5;

const tokenIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** Authenticated user id (better-auth ids are opaque strings). */
const subjectSchema = z.string().min(1).max(128);

const commonClaims = {
  v: z.literal(ROOM_TOKEN_VERSION),
  /** Unique token id; used for tracing, not for server-side replay state. */
  jti: tokenIdSchema,
  /** Issued-at, epoch seconds. */
  iat: z.int().nonnegative(),
  /** Expiry, epoch seconds. */
  exp: z.int().positive(),
};

/**
 * Join token. Bound to one room, one authorization generation, one user and
 * one role, so it cannot be replayed into another room or used past a
 * revocation. Deliberately not bound to an editor instance: the only
 * per-connection identity is the relay-assigned `peerId`, so no client-chosen
 * string is ever signed — which is what keeps key material out of the claims
 * (threat model T13). Another tab of the same user could reuse an unexpired
 * token, but that user can mint another token at will, so the binding never
 * separated two principals.
 */
export const joinTokenClaimsSchema = z.strictObject({
  ...commonClaims,
  aud: z.literal(ROOM_TOKEN_AUDIENCES.join),
  rid: roomIdSchema,
  gen: roomAuthGenerationSchema,
  sub: subjectSchema,
  role: roomRoleSchema,
  /** Authorization revision this token was issued under. */
  arev: roomAuthRevisionSchema,
  /**
   * Room expiry, epoch seconds. `exp` bounds the token; this bounds the
   * session it opens, so the relay drops a connection when the room's own
   * lifetime ends instead of holding it open indefinitely.
   */
  rexp: z.int().positive(),
});
export type JoinTokenClaims = z.infer<typeof joinTokenClaimsSchema>;

export const ROOM_CONTROL_ACTIONS = ["revoke-member", "end-room"] as const;
export type RoomControlAction = (typeof ROOM_CONTROL_ACTIONS)[number];

const controlClaims = {
  ...commonClaims,
  aud: z.literal(ROOM_TOKEN_AUDIENCES.control),
  rid: roomIdSchema,
  gen: roomAuthGenerationSchema,
  /**
   * Revision this change produced. Every join token issued below it is
   * refused, and every session holding one is closed.
   */
  arev: roomAuthRevisionSchema,
};

/**
 * Control token. Authorizes exactly one server-side lifecycle action against
 * one room generation, so the relay never needs a long-lived admin credential
 * and a captured token cannot be repurposed.
 */
export const roomControlClaimsSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...controlClaims,
    action: z.literal("revoke-member"),
    /** Member whose sockets must be closed. */
    sub: subjectSchema,
  }),
  z.strictObject({
    ...controlClaims,
    action: z.literal("end-room"),
  }),
]);
export type RoomControlClaims = z.infer<typeof roomControlClaimsSchema>;

/**
 * The exact claim names each token carries. Tests assert against these so no
 * future change can smuggle encryption key material (or any other secret)
 * into a token the relay and its logs can see.
 */
export const roomTokenClaimKeys = {
  join: [
    "v",
    "jti",
    "iat",
    "exp",
    "aud",
    "rid",
    "gen",
    "sub",
    "role",
    "arev",
    "rexp",
  ],
  control: {
    "revoke-member": [
      "v",
      "jti",
      "iat",
      "exp",
      "aud",
      "rid",
      "gen",
      "arev",
      "action",
      "sub",
    ],
    "end-room": [
      "v",
      "jti",
      "iat",
      "exp",
      "aud",
      "rid",
      "gen",
      "arev",
      "action",
    ],
  },
} as const;
