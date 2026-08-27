import { z } from "zod";

import type { MessageChannel } from "./codec.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  peerIdSchema,
  roomIdSchema,
} from "./messages.ts";
import { maxSealedFrameBytesFor } from "./realtime-crypto.ts";
import { MAX_ROOM_TOKEN_BYTES, roomRoleSchema } from "./room-auth.ts";
import type { DisconnectReason } from "./transport.ts";

/**
 * Wire protocol between a collaboration client and the stateless relay.
 *
 * Two frame kinds travel over one WebSocket connection:
 *
 * - Control frames are JSON text (`join`, `leave` from the client; `joined`,
 *   `peers` from the relay). They carry membership and authorization only,
 *   never scene state.
 * - Data frames are binary: a one-byte channel prefix followed by one sealed
 *   realtime frame (`./realtime-crypto.ts`). The relay routes data frames by
 *   room and channel without decoding the payload — and cannot decode it: the
 *   payload is AES-GCM ciphertext under a key that never leaves the clients.
 */

/**
 * One room member as the relay reports it. The role is included because both
 * client-side elections need it: only a member that may edit the scene can
 * answer a newcomer's full-sync request or write a durable snapshot, and
 * electing a viewer would leave the room with neither. It is the role the relay
 * already enforces per frame, echoed — not a client assertion.
 */
export const relayPeerSchema = z.strictObject({
  peerId: peerIdSchema,
  role: roomRoleSchema,
});
export type RelayPeer = z.infer<typeof relayPeerSchema>;

/**
 * Join request. The room token is mandatory: the relay has no unauthenticated
 * join path, so an unauthorized client can neither subscribe to nor publish
 * into a room. The declared `roomId` must match the token claims, and the
 * room's authorization generation is taken from the token only. The join
 * deliberately carries no client-selected identity: session identity
 * is the relay-assigned `peerId`, so no client-provided string is ever signed
 * or recorded.
 */
export const relayJoinRequestSchema = z.strictObject({
  control: z.literal("join"),
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  roomId: roomIdSchema,
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

/**
 * Sealed-frame ceiling plus the frame header; the relay's transport-level
 * cap. Derived from the single channel budget in `./messages.ts` through the
 * sealed-frame arithmetic in `./realtime-crypto.ts`, so a message the codec
 * accepts can never be refused by the relay for size.
 */
export function maxRelayDataFrameBytesFor(channel: MessageChannel): number {
  return maxSealedFrameBytesFor(channel) + RELAY_DATA_FRAME_HEADER_BYTES;
}

export const MAX_RELAY_DATA_FRAME_BYTES = maxRelayDataFrameBytesFor("scene");

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
 * Optional keepalive frame, version 1 of the pair.
 *
 * Motivation: the Durable Object room runtime hibernates between events, so
 * a traditional server-initiated protocol-level ping (the retired Node
 * relay's liveness mechanism) is ruled out: waking the Object per ping would
 * defeat hibernation, and the browser WebSocket API cannot send
 * protocol-level pings from the client side. Instead the *client* sends this
 * exact text frame on a timer, and the Durable Object answers it with
 * `ctx.setWebSocketAutoResponse()`, which replies without waking the Object.
 *
 * Contract:
 *
 * - Both strings must travel byte-exact: the auto-response matches the whole
 *   frame verbatim, so a client must send the constant itself, never a
 *   re-serialization of it.
 * - The frame is versioned by suffix. A future incompatible keepalive is a new
 *   pair, and an unrecognized keepalive-shaped frame is a protocol violation
 *   like any other unknown control frame.
 * - The response is contractually optional: a client must never *require*
 *   it. Only the Durable Object transport treats the response as its
 *   liveness evidence.
 * - Keepalive is liveness only, never activity: it must not reset any idle
 *   deadline. A forgotten tab that keepalives forever still idles out.
 */
export const RELAY_KEEPALIVE_REQUEST = "drawstuff-keepalive/1";
export const RELAY_KEEPALIVE_RESPONSE = "drawstuff-keepalive-ack/1";

/**
 * Application close codes the relay uses when it terminates a connection.
 *
 * Every one of them ends the session cleanly — there is no half-open state to
 * recover — but they are not interchangeable to the client: some describe a
 * condition that will be gone on the next attempt, and some describe one that a
 * reconnect can only repeat. `disconnectReasonForCloseCode` is that split.
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
  /**
   * The connection exceeded a published send-rate budget. Retryable on purpose:
   * a token bucket refills, so the next attempt is a statement about a different
   * second — and a client that genuinely keeps exceeding it spends the recovery
   * retry budget and stops there with a stated reason.
   */
  rateLimited: 4009,
  /**
   * The connection joined but sent nothing for the idle budget. The heartbeat
   * only proves the socket is alive, which is not the same as the session still
   * being used; without this a forgotten tab holds a room slot forever.
   */
  idleTimeout: 4010,
  /**
   * The relay is already hosting its maximum number of rooms. Distinct from
   * `relayAtCapacity` (too many *connections*) and `roomAtCapacity` (this room
   * is full) so the disconnect-reason breakdown can tell the three apart.
   */
  relayRoomsAtCapacity: 4011,
  /**
   * The relay process is draining so it can be replaced: a deploy, a rolling
   * restart, or the max-memory watchdog. Retryable on purpose — the condition
   * is about *this* process, and the recovery backoff is what carries the
   * client across the handover to the replacement. Sent both when an existing
   * connection is drained and when a new connection arrives mid-drain.
   */
  relayRestarting: 4012,
  /**
   * The join declared a protocol version *older* than this relay's — a tab
   * still running code from before a `COLLABORATION_PROTOCOL_VERSION` bump.
   * Distinct from `protocolViolation` because the honest instruction differs:
   * a violation says "this client is broken", this says "reload to pick up
   * the current version". Terminal for the running code either way —
   * reconnecting without reloading resends the same version. A *newer*
   * version than the relay's never gets this code; see
   * `unsupportedJoinProtocolVersionOf`.
   */
  unsupportedProtocolVersion: 4013,
  /**
   * A frame handler threw inside the relay — the relay's own defect, not the
   * client's. Honesty is the point of the distinct code: `protocolViolation`
   * would tell the client "you are broken, report a bug" and end the session
   * terminally for a failure the client did not cause. Deliberately *not*
   * enumerated in `disconnectReasonForCloseCode`, so it reads as `transient`
   * by construction and a reconnect is worth trying.
   *
   * Retries are bounded wherever the defect fires. Before the baseline
   * resolves, the recovery retry budget applies directly. After a successful
   * baseline, the budget is repaid only once the session has *stayed* live for
   * the recovery machine's stability window (`./recovery.ts`), so a defect
   * that reproduces on the first post-sync frame keeps spending one budget
   * across its sync-and-die loops and ends in `retry-limit` with a stated
   * reason.
   */
  internalError: 4014,
} as const;
export type RelayCloseCode =
  (typeof RELAY_CLOSE_CODES)[keyof typeof RELAY_CLOSE_CODES];

/**
 * Maps a WebSocket close code to the reason a client acts on.
 *
 * The default is `transient`, and that direction is deliberate: an unknown or
 * absent code is what a failed TCP connection, a proxy, a load-balancer restart
 * and a browser tab suspension all produce, and every one of those is worth
 * retrying. The codes that must *not* be retried are the ones the relay states
 * explicitly, so they are the ones enumerated here — a terminal condition is
 * never inferred from silence.
 *
 * `roomAtCapacity`, `relayAtCapacity`, `relayRoomsAtCapacity`, `rateLimited` and
 * `idleTimeout` all count as transient because they are statements about right
 * now, and the retry budget (`./recovery.ts`) is what stops a condition that
 * never clears from being retried forever. They reach `transient` through the
 * default rather than through a case of their own — the enumerated cases are
 * exactly the terminal ones, so a new capacity-style code is retryable by
 * construction and cannot become terminal by omission.
 */
export function disconnectReasonForCloseCode(
  code: number | undefined,
): DisconnectReason {
  switch (code) {
    case RELAY_CLOSE_CODES.unauthorized:
      return "unauthorized";
    case RELAY_CLOSE_CODES.membershipRevoked:
      return "membership-revoked";
    case RELAY_CLOSE_CODES.roomEnded:
      return "room-ended";
    case RELAY_CLOSE_CODES.protocolViolation:
    case RELAY_CLOSE_CODES.readOnlyRole:
      return "protocol";
    case RELAY_CLOSE_CODES.unsupportedProtocolVersion:
      return "unsupported-protocol-version";
    default:
      return "transient";
  }
}

/**
 * Detects a join whose stated protocol version is not the one this build
 * speaks.
 *
 * `relayJoinRequestSchema` pins the version as a literal, so an old tab's join
 * fails parsing outright — and folding that into "malformed control frame"
 * (`protocolViolation`) is what used to tell a merely *outdated* client that
 * it was broken. This probe is deliberately loose: it answers only "is this
 * join-shaped with a numeric version *below* ours", so the relay can close
 * with `unsupportedProtocolVersion` and the client can say "reload" instead of
 * "report a bug". Full validation still happens in the strict schema; a
 * join-shaped frame that fails it for other reasons stays a violation.
 *
 * Deliberately below-only. A version *above* ours is not an outdated tab — it
 * is an outdated *relay*, the transient state of a rollout where clients pick
 * up a protocol bump before the relay fleet does — and telling that client to
 * refresh would prescribe the one action that cannot help. It falls through
 * to the generic violation path, exactly as it did before this code existed.
 */
export function unsupportedJoinProtocolVersionOf(
  text: string,
): number | undefined {
  if (text.length > MAX_RELAY_CONTROL_FRAME_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("control" in raw) || raw.control !== "join") return undefined;
  if (!("protocolVersion" in raw)) return undefined;
  const version = raw.protocolVersion;
  if (typeof version !== "number") return undefined;
  return version < COLLABORATION_PROTOCOL_VERSION ? version : undefined;
}
