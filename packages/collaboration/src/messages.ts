import { z } from "zod";

/**
 * Version of the realtime collaboration wire protocol. This is independent
 * from the Drawstuff scene document version (currently V4): documents version
 * persisted payloads, this versions transport messages. Durable formats
 * (snapshots, assets) are decoupled from it, so bumping it never
 * affects stored ciphertext.
 *
 * v2: removed `senderClientId` — collaboration identity is the
 * relay-assigned `peerId` only.
 */
export const COLLABORATION_PROTOCOL_VERSION = 2;

/**
 * Hard cap applied to raw encoded bytes before any JSON parsing. Messages
 * above this size are rejected without being decoded.
 */
export const MAX_SCENE_MESSAGE_BYTES = 1_048_576;

/**
 * Presence messages are volatile and frequent, so they get a much smaller
 * budget than scene messages.
 */
export const MAX_PRESENCE_MESSAGE_BYTES = 16_384;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const roomIdSchema = z.string().regex(ID_PATTERN).brand<"RoomId">();
export type RoomId = z.infer<typeof roomIdSchema>;

/**
 * One connected session of a client. A reconnect produces a new `PeerId`, so
 * session-ordered sequences are always scoped to a single uninterrupted
 * connection.
 */
export const peerIdSchema = z.string().regex(ID_PATTERN).brand<"PeerId">();
export type PeerId = z.infer<typeof peerIdSchema>;

/**
 * Element bodies are owned by the canvas engine and pass through unprojected,
 * exactly like scene persistence. Validation only pins the identity fields
 * reconciliation depends on and rejects embedded binary payloads: binary
 * assets travel through the asset pipeline, never inside element messages.
 */
export const FORBIDDEN_BINARY_ELEMENT_KEYS = ["dataURL"] as const;

export const syncedElementSchema = z
  .looseObject({
    id: z.string().min(1),
    version: z.int().nonnegative(),
    versionNonce: z.int(),
    isDeleted: z.boolean(),
  })
  .superRefine((element, ctx) => {
    for (const key of FORBIDDEN_BINARY_ELEMENT_KEYS) {
      if (key in element) {
        ctx.addIssue({
          code: "custom",
          message: `Element must not embed binary asset data ("${key}")`,
          path: [key],
        });
      }
    }
  });
export type SyncedElement = z.infer<typeof syncedElementSchema>;

/**
 * Fields shared by every message. `sequence` starts at 1 and increments per
 * sender session, with independent counters for the session-ordered scene
 * family and the volatile presence family (so dropped presence messages never
 * look like scene gaps). `roomGeneration` identifies the room epoch assigned
 * at join time so messages from a previous epoch (relay restart, room
 * re-creation) are rejected instead of silently merged.
 */
const messageEnvelopeFields = {
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  /** Unique per message; for tracing only. Idempotency uses (senderPeerId, sequence). */
  messageId: z.string().regex(ID_PATTERN),
  roomId: roomIdSchema,
  roomGeneration: z.int().positive(),
  senderPeerId: peerIdSchema,
  sequence: z.int().positive(),
};

/**
 * Session-ordered full-scene snapshot. Sent when joining and whenever a
 * receiver reports a sequence gap; a snapshot heals any missed deltas.
 */
export const sceneInitMessageSchema = z.strictObject({
  ...messageEnvelopeFields,
  type: z.literal("scene-init"),
  payload: z.strictObject({
    elements: z.array(syncedElementSchema),
  }),
});
export type SceneInitMessage = z.infer<typeof sceneInitMessageSchema>;

/**
 * Session-ordered element delta. Delivery is only ordered within one sender
 * session; the transport does not replay messages across reconnects. Gaps are
 * detected by the receiver and repaired with a `scene-init` snapshot plus
 * reconciliation, never papered over by the relay.
 */
export const sceneUpdateMessageSchema = z.strictObject({
  ...messageEnvelopeFields,
  type: z.literal("scene-update"),
  payload: z.strictObject({
    elements: z.array(syncedElementSchema),
  }),
});
export type SceneUpdateMessage = z.infer<typeof sceneUpdateMessageSchema>;

export type SceneMessage = SceneInitMessage | SceneUpdateMessage;

/**
 * Volatile presence state (pointer, selection, idle). Latest-wins per sender:
 * receivers drop stale sequences, and losing a presence message never affects
 * scene convergence.
 */
export const presenceMessageSchema = z.strictObject({
  ...messageEnvelopeFields,
  type: z.literal("presence"),
  payload: z.strictObject({
    pointer: z.strictObject({
      x: z.number(),
      y: z.number(),
      tool: z.enum(["pointer", "laser"]),
    }),
    button: z.enum(["up", "down"]),
    username: z.string().max(128),
    selectedElementIds: z.array(z.string().min(1).max(64)).max(256),
    idleState: z.enum(["active", "idle", "away"]),
  }),
});
export type PresenceMessage = z.infer<typeof presenceMessageSchema>;

export const collaborationMessageSchema = z.discriminatedUnion("type", [
  sceneInitMessageSchema,
  sceneUpdateMessageSchema,
  presenceMessageSchema,
]);
export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;

export function maxEncodedBytesFor(type: CollaborationMessage["type"]): number {
  return type === "presence"
    ? MAX_PRESENCE_MESSAGE_BYTES
    : MAX_SCENE_MESSAGE_BYTES;
}
