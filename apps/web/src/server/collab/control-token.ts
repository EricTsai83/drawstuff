import "server-only";

import {
  DEFAULT_CONTROL_TOKEN_TTL_SECONDS,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomControlAction,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signRoomControlToken,
} from "@drawstuff/collaboration/room-token";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";

import { env } from "@/env";

/**
 * Shared half of every control push: one signed, short-lived, single-action
 * token, and one closed result union. The Node relay client and the Durable
 * Object gateway client both build on this, so a control action means the
 * same thing regardless of which provider enforces it.
 */

/** Control calls are server-to-server and must not block a mutation. */
export const CONTROL_REQUEST_TIMEOUT_MS = 3_000;

export type RoomControlPushParams = {
  roomId: string;
  authGeneration: number;
  /** Revision this change produced; the provider's revocation cutoff. */
  authRevision: number;
  now: Date;
} & (
  | { action: Extract<RoomControlAction, "revoke-member">; userId: string }
  | { action: Extract<RoomControlAction, "end-room"> }
);

/**
 * Closed result union: enforcement either happened with a socket count, or it
 * did not and the caller learns why instead of assuming it.
 */
export type RoomControlPushResult =
  | { enforced: true; closedSessions: number }
  | { enforced: false; reason: string };

/** Signs the single-action control token for one push. */
export function issueRoomControlToken(params: RoomControlPushParams): string {
  const issuedAtSeconds = Math.floor(params.now.getTime() / 1000);
  const common = {
    v: ROOM_TOKEN_VERSION,
    jti: createRoomTokenId(),
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + DEFAULT_CONTROL_TOKEN_TTL_SECONDS,
    aud: ROOM_TOKEN_AUDIENCES.control,
    rid: roomIdSchema.parse(params.roomId),
    gen: params.authGeneration,
    arev: params.authRevision,
  } as const;
  return signRoomControlToken(
    params.action === "end-room"
      ? { ...common, action: "end-room" }
      : { ...common, action: "revoke-member", sub: params.userId },
    env.COLLAB_JOIN_TOKEN_SECRET,
  );
}
