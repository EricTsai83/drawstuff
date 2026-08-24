import { z } from "zod";

import { peerIdSchema, roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  roomAuthGenerationSchema,
  roomAuthRevisionSchema,
  roomRoleSchema,
} from "@drawstuff/collaboration/room-auth";

/**
 * Versioned per-socket attachment: the only connection state that survives
 * hibernation, eviction and code updates. Everything the room
 * runtime needs about a socket is recoverable from `ctx.getWebSockets()` plus
 * this value; any in-memory map is a per-event cache, never authority.
 *
 * Deliberately excluded, and pinned by `roomSocketAttachmentKeys` below: the
 * join token, room keys, ciphertext, presence profiles and scene data. The
 * attachment is duplicated into every socket's V8-serialized storage, so it
 * must carry authorization *results*, never secrets or payloads.
 *
 * Size contract: `serializeAttachment()` persists the whole value on every
 * write and the platform caps it at 2 KiB. `tests/attachment.test.ts` proves
 * every variant serialized with maximum-size field values stays far below
 * that cap, so the limit can never surface as a runtime error.
 */

const epochMillisSchema = z.int().nonnegative();

/** Accepted socket that has not presented a valid join control yet. */
const pendingAttachmentSchema = z.strictObject({
  v: z.literal(1),
  state: z.literal("pending"),
  acceptedAt: epochMillisSchema,
  roomId: roomIdSchema,
  authGeneration: roomAuthGenerationSchema,
});

/** Authorized member; the fields mirror what the relay held in memory. */
const joinedAttachmentSchema = z.strictObject({
  v: z.literal(1),
  state: z.literal("joined"),
  peerId: peerIdSchema,
  /** Authenticated user id from the verified join token (`sub`). */
  subject: z.string().min(1).max(128),
  role: roomRoleSchema,
  /** Authorization revision (`arev`) of the join token presented. */
  tokenRevision: roomAuthRevisionSchema,
  /** Session epoch this cohort shares; `roomGeneration` on the wire. */
  roomEpoch: z.int().positive(),
  /** Room lifetime bound from the token (`rexp`), epoch milliseconds. */
  roomExpiresAt: epochMillisSchema,
  joinedAt: epochMillisSchema,
  /**
   * Last accepted data frame, epoch milliseconds — persisted lazily. The live
   * value may run ahead by up to `LAST_FRAME_PERSIST_QUANTUM_MS`, and every
   * deadline derived from this field adds that quantum so staleness can only
   * ever delay a close, never cause an early one.
   */
  lastFrameAt: epochMillisSchema,
});

/**
 * Attachments are versioned as a whole (`v`), and an unknown version fails
 * closed: after a code rollback or a corrupted write the socket is closed
 * with `internalError` rather than interpreted by guesswork.
 */
export const roomSocketAttachmentSchema = z.discriminatedUnion("state", [
  pendingAttachmentSchema,
  joinedAttachmentSchema,
]);

export type PendingSocketAttachment = z.infer<typeof pendingAttachmentSchema>;
export type JoinedSocketAttachment = z.infer<typeof joinedAttachmentSchema>;
export type RoomSocketAttachment = z.infer<typeof roomSocketAttachmentSchema>;

/**
 * The exact keys each variant persists. Tests assert against these so no
 * future change can smuggle a token, key or payload field into the attachment
 * unnoticed — the same pinning pattern as `roomTokenClaimKeys`.
 */
export const roomSocketAttachmentKeys = {
  pending: ["v", "state", "acceptedAt", "roomId", "authGeneration"],
  joined: [
    "v",
    "state",
    "peerId",
    "subject",
    "role",
    "tokenRevision",
    "roomEpoch",
    "roomExpiresAt",
    "joinedAt",
    "lastFrameAt",
  ],
} as const;

/**
 * Reads and validates a socket's attachment. `undefined` means the socket is
 * unusable — no attachment, an unparseable one, or an unknown version — and
 * the caller must fail closed by closing that socket.
 */
export function readRoomSocketAttachment(
  ws: WebSocket,
): RoomSocketAttachment | undefined {
  let raw: unknown;
  try {
    raw = ws.deserializeAttachment();
  } catch {
    return undefined;
  }
  const parsed = roomSocketAttachmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function writeRoomSocketAttachment(
  ws: WebSocket,
  attachment: RoomSocketAttachment,
): void {
  ws.serializeAttachment(attachment);
}
