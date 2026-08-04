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
 * Pushes a membership or lifecycle change to the relay so it takes effect on
 * connections that already joined.
 *
 * The database is the source of truth for who may join next; this call is what
 * closes the sockets of someone who joined a moment ago. It is therefore
 * reported, never swallowed: a caller that cannot reach the relay learns that
 * live sessions may still be connected, instead of assuming enforcement.
 */

/** Must match the relay's `RELAY_CONTROL_PATH`. */
const RELAY_CONTROL_PATH = "/control/room";

/** Control calls are local, server-to-server, and must not block a mutation. */
const CONTROL_REQUEST_TIMEOUT_MS = 3_000;

export type RelayControlResult =
  | { enforced: true; closedSessions: number }
  | { enforced: false; reason: string };

type RelayControlResponse = { action?: string; closed?: number };

export async function pushRelayRoomControl(
  params: {
    roomId: string;
    authGeneration: number;
    /** Revision this change produced; the relay's revocation cutoff. */
    authRevision: number;
    now: Date;
  } & (
    | { action: Extract<RoomControlAction, "revoke-member">; userId: string }
    | { action: Extract<RoomControlAction, "end-room"> }
  ),
): Promise<RelayControlResult> {
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
  const token = signRoomControlToken(
    params.action === "end-room"
      ? { ...common, action: "end-room" }
      : { ...common, action: "revoke-member", sub: params.userId },
    env.COLLAB_JOIN_TOKEN_SECRET,
  );

  try {
    const response = await fetch(
      new URL(RELAY_CONTROL_PATH, env.COLLAB_RELAY_CONTROL_URL),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return { enforced: false, reason: `relay responded ${response.status}` };
    }
    const body = (await response.json()) as RelayControlResponse;
    return {
      enforced: true,
      closedSessions: typeof body.closed === "number" ? body.closed : 0,
    };
  } catch (error) {
    return {
      enforced: false,
      reason: error instanceof Error ? error.message : "relay unreachable",
    };
  }
}
