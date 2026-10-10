import { roomIdSchema, type RoomId } from "@drawstuff/collaboration/protocol";

/**
 * Internal identity contract between the gateway and `CollaborationRoomV2`.
 *
 * The gateway is the only writer: it strips this header off the public
 * request before setting its own parsed value, so a client can never smuggle
 * a routing identity past the route parser. The Object is the only reader,
 * and it re-parses with the exact same grammar and then compares the room id
 * against `ctx.id.name` — the forwarded metadata is a hint to verify, never an
 * authority to trust.
 */
export const INTERNAL_ROOM_ID_HEADER = "x-drawstuff-internal-room-id";

export function readInternalSocketRoomId(headers: Headers): RoomId | undefined {
  const parsed = roomIdSchema.safeParse(headers.get(INTERNAL_ROOM_ID_HEADER));
  return parsed.success ? parsed.data : undefined;
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
