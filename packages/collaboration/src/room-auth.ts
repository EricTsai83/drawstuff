import { z } from "zod";

/**
 * Room role and identity-proof contract shared by the Drawstuff app (the only
 * proof issuer) and the room runtime (the only verifier).
 *
 * No cryptography lives here, so this module stays safe to import from a
 * browser bundle. HMAC signing and verification are in `./room-token.ts`,
 * which is server-only.
 *
 * A proof carries identity only, never a role: the room computes the role from
 * its own access rules (owner, invitation list, general access) every time it
 * is asked, so a role can never be frozen into a token or a member record.
 */

export const ROOM_ROLES = ["owner", "editor", "viewer"] as const;
export const roomRoleSchema = z.enum(ROOM_ROLES);
export type RoomRole = z.infer<typeof roomRoleSchema>;

/**
 * Viewers receive scene traffic but must never mutate the scene. The room
 * enforces this on every inbound frame; the editor UI mirrors it as read-only
 * state, so the check exists on both sides and neither is load-bearing alone.
 */
export function roomRoleCanEditScene(role: RoomRole): boolean {
  return role === "owner" || role === "editor";
}

/** Hard cap on a proof string, applied before any parsing. */
export const MAX_ROOM_TOKEN_BYTES = 1_024;

/** Identity proofs are short-lived so a leaked proof expires on its own. */
export const DEFAULT_IDENTITY_PROOF_TTL_SECONDS = 60;
/** Verifiers reject a longer TTL even if the issuer asks for one. */
export const MAX_IDENTITY_PROOF_TTL_SECONDS = 300;

/** Small clock-skew allowance between the app and the room runtime. */
export const ROOM_TOKEN_CLOCK_SKEW_SECONDS = 5;
