import { z } from "zod";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  roomAuthGenerationSchema,
  roomAuthRevisionSchema,
  roomChannelKey,
  type RoomChannelKey,
  type RoomControlClaims,
} from "@drawstuff/collaboration/room-auth";

/**
 * Versioned typed-RPC contract between the gateway and `CollaborationRoom`
 * (Plan 11 P1). The gateway verifies the control token; the Object re-checks
 * the command against its own identity, so a bug in either side fails closed
 * rather than coordinating the wrong room.
 *
 * Version-skew rules (gateway and Object may briefly run different builds
 * during a global rollout):
 *
 * - new fields on V1 may only ever be optional — the schemas are non-strict
 *   so an older Object strips a newer gateway's additions instead of
 *   rejecting them;
 * - `applyControlV1` must survive at least one full deployment window after a
 *   successor exists; a breaking change ships as `applyControlV2`, never as a
 *   mutation of this contract.
 */

/** Same bounds as the `sub` claim in `room-auth.ts` (kept private there). */
const subjectSchema = z.string().min(1).max(128);

const commandCommon = {
  v: z.literal(1),
  roomId: roomIdSchema,
  authGeneration: roomAuthGenerationSchema,
  /** Revision the control action produced; the durable cutoff to record. */
  revision: roomAuthRevisionSchema,
};

/**
 * Only the two idempotent lifecycle actions exist; anything else the gateway
 * could conceivably want must arrive as a new schema, not a new literal.
 */
export const roomControlCommandV1Schema = z.discriminatedUnion("action", [
  z.object({
    ...commandCommon,
    action: z.literal("revoke-member"),
    /** Member whose lower-revision sockets must be closed. */
    subject: subjectSchema,
  }),
  z.object({
    ...commandCommon,
    action: z.literal("end-room"),
  }),
]);
export type RoomControlCommandV1 = z.infer<typeof roomControlCommandV1Schema>;

/**
 * RPC result: the revision now durably in force for the addressed cutoff
 * scope (at least the command's — an out-of-order replay reports the newer
 * stored one) and the sockets this call closed. Nothing else, so no subject
 * or room state can leak back through the gateway.
 */
export type RoomControlResultV1 = {
  appliedRevision: number;
  closed: number;
};

/** Channel key a verified control token addresses. */
export function controlClaimsChannelKey(
  claims: RoomControlClaims,
): RoomChannelKey {
  return roomChannelKey(claims.rid, claims.gen);
}

/** Maps verified control-token claims onto the V1 command, field by field. */
export function roomControlCommandFromClaims(
  claims: RoomControlClaims,
): RoomControlCommandV1 {
  const common = {
    v: 1,
    roomId: claims.rid,
    authGeneration: claims.gen,
    revision: claims.arev,
  } as const;
  return claims.action === "revoke-member"
    ? { ...common, action: "revoke-member", subject: claims.sub }
    : { ...common, action: "end-room" };
}
