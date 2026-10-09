import { z } from "zod";
import { AUTHORITY_CONTRACT_VERSION, operationIdSchema } from "./authority.ts";
import { roomIdSchema } from "./messages.ts";
import { roomKeySchema } from "./realtime-crypto.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";

/**
 * Server custody of room keys (plan 19). Room keeps a wrapped copy of each
 * generation's room key and releases it only to the owner, current members
 * and allowlisted emails, so they can reopen a room without its link.
 *
 * Kept off the general authority path on purpose: no other request or result
 * schema carries a key, so the generic `execute` route cannot reach one.
 */
export const ROOM_KEY_GATEWAY_PATH = "/v1/room-key";

const envelope = {
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  operationId: operationIdSchema,
  roomId: roomIdSchema,
  deadline: z.int().positive(),
};

export const roomKeyRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...envelope, action: z.literal("get-room-key") }),
  z.strictObject({
    ...envelope,
    action: z.literal("escrow-room-key"),
    /**
     * Pins the generation a creation sealed. A backfill from a joined link may
     * omit it: Room checks the key against its current key check either way,
     * so an older generation's key is refused.
     */
    authGeneration: roomAuthGenerationSchema.optional(),
    roomKey: roomKeySchema,
  }),
]);
export type RoomKeyRequest = z.infer<typeof roomKeyRequestSchema>;

export const roomKeyGatewayRequestSchema = z.strictObject({
  proof: z.string().min(1).max(2_048),
  request: roomKeyRequestSchema,
});

export const roomKeyResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("found"),
    roomId: roomIdSchema,
    authGeneration: roomAuthGenerationSchema,
    roomKey: roomKeySchema,
  }),
  /** Room holds no key for the current generation yet (created before custody). */
  z.strictObject({
    status: z.literal("absent"),
    roomId: roomIdSchema,
    authGeneration: roomAuthGenerationSchema,
  }),
  z.strictObject({
    status: z.literal("escrowed"),
    roomId: roomIdSchema,
    authGeneration: roomAuthGenerationSchema,
  }),
]);
export type RoomKeyResult = z.infer<typeof roomKeyResultSchema>;

export const roomKeyGatewayResponseSchema = z.strictObject({
  ok: z.literal(true),
  result: roomKeyResultSchema,
});
