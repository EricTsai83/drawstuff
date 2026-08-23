import {
  roomAuthGenerationSchema,
  roomChannelKey,
  type RoomChannelKey,
} from "@drawstuff/collaboration/room-auth";
import { roomIdSchema, type RoomId } from "@drawstuff/collaboration/protocol";

/**
 * Internal identity contract between the gateway and `CollaborationRoom`.
 *
 * The gateway is the only writer: it strips these header names off the public
 * request before setting its own parsed values, so a client can never smuggle
 * a routing identity past the route parser. The Object is the only reader,
 * and it re-parses with the exact same grammar and then compares the derived
 * `RoomChannelKey` against `ctx.id.name` — the forwarded metadata is a hint
 * to verify, never an authority to trust.
 */
export const INTERNAL_ROOM_ID_HEADER = "x-drawstuff-internal-room-id";
export const INTERNAL_AUTH_GENERATION_HEADER =
  "x-drawstuff-internal-auth-generation";

export interface SocketRouteIdentity {
  roomId: RoomId;
  authGeneration: number;
  channelKey: RoomChannelKey;
}

/**
 * A generation segment must be the canonical decimal rendering of a positive
 * integer: no sign, no leading zero, and bounded well below 2^53 so
 * `Number()` is exact.
 */
const GENERATION_SEGMENT_PATTERN = /^[1-9][0-9]{0,9}$/;

export function parseSocketRouteIdentity(
  roomIdSegment: string,
  generationSegment: string,
): SocketRouteIdentity | undefined {
  const roomId = roomIdSchema.safeParse(roomIdSegment);
  if (!roomId.success) return undefined;
  if (!GENERATION_SEGMENT_PATTERN.test(generationSegment)) return undefined;
  const authGeneration = roomAuthGenerationSchema.safeParse(
    Number(generationSegment),
  );
  if (!authGeneration.success) return undefined;
  return {
    roomId: roomId.data,
    authGeneration: authGeneration.data,
    channelKey: roomChannelKey(roomId.data, authGeneration.data),
  };
}

export function readInternalSocketIdentity(
  headers: Headers,
): SocketRouteIdentity | undefined {
  const roomId = headers.get(INTERNAL_ROOM_ID_HEADER);
  const generation = headers.get(INTERNAL_AUTH_GENERATION_HEADER);
  if (roomId === null || generation === null) return undefined;
  return parseSocketRouteIdentity(roomId, generation);
}

/**
 * Uniform closed response: a fixed error code and nothing else. No request
 * data is ever echoed back, and internal failure detail stays in the logs.
 */
export function closedJsonResponse(
  status: number,
  error: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error }, { status, headers });
}
