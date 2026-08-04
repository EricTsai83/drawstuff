import { z } from "zod";

import type { MessageChannel } from "./codec.ts";
import {
  clientIdSchema,
  COLLABORATION_PROTOCOL_VERSION,
  MAX_PRESENCE_MESSAGE_BYTES,
  MAX_SCENE_MESSAGE_BYTES,
  peerIdSchema,
  roomIdSchema,
} from "./messages.ts";
import { MAX_ROOM_TOKEN_BYTES, roomRoleSchema } from "./room-auth.ts";

/**
 * Wire protocol between a collaboration client and the stateless relay.
 *
 * Two frame kinds travel over one WebSocket connection:
 *
 * - Control frames are JSON text (`join`, `leave` from the client; `joined`,
 *   `peers` from the relay). They carry membership and authorization only,
 *   never scene state.
 * - Data frames are binary: a one-byte channel prefix followed by the exact
 *   bytes produced by the protocol codec. The relay routes data frames by
 *   room and channel without decoding the payload, so element semantics stay
 *   entirely client-side.
 */

export const relayPeerSchema = z.strictObject({
  peerId: peerIdSchema,
  clientId: clientIdSchema,
});
export type RelayPeer = z.infer<typeof relayPeerSchema>;

/**
 * Join request. The room token is mandatory: the relay has no unauthenticated
 * join path, so an unauthorized client can neither subscribe to nor publish
 * into a room. The declared `roomId`/`clientId` must match the token claims,
 * and the room's authorization generation is taken from the token only.
 */
export const relayJoinRequestSchema = z.strictObject({
  control: z.literal("join"),
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  roomId: roomIdSchema,
  clientId: clientIdSchema,
  token: z.string().min(1).max(MAX_ROOM_TOKEN_BYTES),
});
export type RelayJoinRequest = z.infer<typeof relayJoinRequestSchema>;

export const relayLeaveRequestSchema = z.strictObject({
  control: z.literal("leave"),
});

export const relayClientControlSchema = z.discriminatedUnion("control", [
  relayJoinRequestSchema,
  relayLeaveRequestSchema,
]);
export type RelayClientControl = z.infer<typeof relayClientControlSchema>;

/** Join acknowledgment: session identity assigned by the relay, the role the
 *  relay will enforce for this connection, plus the current room membership
 *  (including the joiner itself). */
export const relayJoinedNoticeSchema = z.strictObject({
  control: z.literal("joined"),
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  roomId: roomIdSchema,
  peerId: peerIdSchema,
  roomGeneration: z.int().positive(),
  /** Echoed from the verified token so the client mirrors the authoritative
   *  server-side decision instead of trusting its own copy. */
  role: roomRoleSchema,
  peers: z.array(relayPeerSchema),
});
export type RelayJoinedNotice = z.infer<typeof relayJoinedNoticeSchema>;

/** Full membership broadcast sent to every member on join/leave churn. */
export const relayPeersNoticeSchema = z.strictObject({
  control: z.literal("peers"),
  peers: z.array(relayPeerSchema),
});
export type RelayPeersNotice = z.infer<typeof relayPeersNoticeSchema>;

export const relayServerControlSchema = z.discriminatedUnion("control", [
  relayJoinedNoticeSchema,
  relayPeersNoticeSchema,
]);
export type RelayServerControl = z.infer<typeof relayServerControlSchema>;

/**
 * Hard cap for a JSON control frame. Membership notices scale with room size,
 * which the relay bounds via its per-room connection limit, so control frames
 * stay far below this.
 */
export const MAX_RELAY_CONTROL_FRAME_BYTES = 65_536;

/** One-byte data frame prefix identifying the wire channel. */
const CHANNEL_BYTE: Record<MessageChannel, number> = {
  scene: 0x01,
  presence: 0x02,
};

const CHANNEL_BY_BYTE = new Map<number, MessageChannel>([
  [0x01, "scene"],
  [0x02, "presence"],
]);

export const RELAY_DATA_FRAME_HEADER_BYTES = 1;

/** Channel budget plus the frame header; the relay's transport-level cap. */
export const MAX_RELAY_DATA_FRAME_BYTES =
  MAX_SCENE_MESSAGE_BYTES + RELAY_DATA_FRAME_HEADER_BYTES;

export function maxRelayDataFrameBytesFor(channel: MessageChannel): number {
  const maxPayload =
    channel === "presence"
      ? MAX_PRESENCE_MESSAGE_BYTES
      : MAX_SCENE_MESSAGE_BYTES;
  return maxPayload + RELAY_DATA_FRAME_HEADER_BYTES;
}

export function encodeRelayDataFrame(
  channel: MessageChannel,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(
    payload.byteLength + RELAY_DATA_FRAME_HEADER_BYTES,
  );
  frame[0] = CHANNEL_BYTE[channel];
  frame.set(payload, RELAY_DATA_FRAME_HEADER_BYTES);
  return frame;
}

export type RelayDataFrame = {
  channel: MessageChannel;
  payload: Uint8Array;
};

/** Returns `undefined` for an empty frame or an unknown channel byte. */
export function decodeRelayDataFrame(
  frame: Uint8Array,
): RelayDataFrame | undefined {
  if (frame.byteLength < RELAY_DATA_FRAME_HEADER_BYTES) {
    return undefined;
  }
  const channel = CHANNEL_BY_BYTE.get(frame[0] ?? 0);
  if (!channel) {
    return undefined;
  }
  return {
    channel,
    payload: frame.subarray(RELAY_DATA_FRAME_HEADER_BYTES),
  };
}

export function encodeRelayControl(
  control: RelayClientControl | RelayServerControl,
): string {
  return JSON.stringify(control);
}

const parseControl = <Schema extends z.ZodType>(
  schema: Schema,
  text: string,
): z.infer<Schema> | undefined => {
  if (text.length > MAX_RELAY_CONTROL_FRAME_BYTES) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

export function parseRelayClientControl(
  text: string,
): RelayClientControl | undefined {
  return parseControl(relayClientControlSchema, text);
}

export function parseRelayServerControl(
  text: string,
): RelayServerControl | undefined {
  return parseControl(relayServerControlSchema, text);
}

/**
 * Application close codes the relay uses when it terminates a connection.
 * Clients treat every one of them as a normal disconnect: the session model
 * heals by reconnecting and exchanging `scene-init` snapshots.
 */
export const RELAY_CLOSE_CODES = {
  /** Malformed control frame, unknown data frame, oversize payload, or a
   *  data frame sent before joining. */
  protocolViolation: 4000,
  /** The relay-wide connection limit is reached. */
  relayAtCapacity: 4001,
  /** The per-room connection limit is reached. */
  roomAtCapacity: 4002,
  /** The socket's outbound buffer stayed over budget; the receiver is not
   *  draining fast enough and would grow relay memory without bound. */
  slowConsumer: 4003,
  /** The socket never sent a valid join within the join deadline. */
  joinTimeout: 4004,
  /** No token, or a token that failed signature/audience/expiry/binding
   *  verification. The client must obtain a fresh token from the app. */
  unauthorized: 4005,
  /** A viewer attempted to publish a scene mutation. */
  readOnlyRole: 4006,
  /** The member's room authorization was revoked while connected. */
  membershipRevoked: 4007,
  /** The room generation was ended (or rotated) by its owner. */
  roomEnded: 4008,
} as const;
export type RelayCloseCode =
  (typeof RELAY_CLOSE_CODES)[keyof typeof RELAY_CLOSE_CODES];
