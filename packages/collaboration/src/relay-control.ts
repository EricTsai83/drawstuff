import { z } from "zod";

import { MAX_ROOM_TOKEN_BYTES, roomAuthRevisionSchema } from "./room-auth.ts";

/**
 * Server-to-server control contract between the app backend and the Durable
 * Object gateway.
 *
 * The app pushes a membership or lifecycle change (a signed, single-action
 * control token) and the gateway closes the matching sockets. This module is
 * the single home of the HTTP control channel, the same way every WebSocket
 * contract lives in `./relay-protocol.ts`. Token claims themselves are in
 * `./room-auth.ts` / `./room-token.ts`.
 */

/**
 * Durable Object gateway control endpoint. The room's identity travels
 * inside the verified token claims only — the gateway derives the target
 * Object from them, so the body stays one token with nothing else to trust.
 */
export const DO_GATEWAY_CONTROL_PATH = "/v1/control";

/**
 * Socket path on the Durable Object gateway for one room generation. Must
 * stay in lockstep with the gateway's `SOCKET_ROUTE_PATTERN`
 * (`apps/collaboration-do/src/gateway.ts`); the app backend composes the
 * full URL server-side and hands it to clients as an opaque `relayUrl`, so
 * no provider knowledge ever reaches the client.
 */
export function doGatewaySocketPath(
  roomId: string,
  authGeneration: number,
): string {
  return `/v1/rooms/${roomId}/generations/${authGeneration}/socket`;
}

/**
 * Control bodies carry exactly one token. Strict where the relay's schema is
 * lenient: the gateway is new surface, so unknown keys fail closed from day
 * one instead of inheriting the relay's historical tolerance.
 */
export const doGatewayControlRequestSchema = z.strictObject({
  token: z.string().min(1).max(MAX_ROOM_TOKEN_BYTES),
});
export type DoGatewayControlRequest = z.infer<
  typeof doGatewayControlRequestSchema
>;

/**
 * Successful gateway control response — the typed RPC result passed through:
 * the revision now durably in force for the addressed cutoff scope, and the
 * live sockets closed by this call. Deliberately nothing else (no subjects,
 * no room state), and parsed non-strictly so a newer gateway may add optional
 * fields without breaking an older caller.
 */
export const doGatewayControlResponseSchema = z.object({
  appliedRevision: roomAuthRevisionSchema,
  closed: z.int().nonnegative(),
});
export type DoGatewayControlResponse = z.infer<
  typeof doGatewayControlResponseSchema
>;

/**
 * Non-retryable gateway refusal. The Object could only refuse the same
 * command again (malformed intent, wrong channel, schema skew), so the caller's
 * durable dispatcher must mark the event terminal instead of spending its
 * retry budget. Any other non-2xx stays retryable. `code` is opaque to the
 * caller — it is recorded, never branched on.
 */
export const DO_GATEWAY_CONTROL_REJECTED_STATUS = 422;
export const doGatewayControlRejectionSchema = z.object({
  error: z.literal("control-rejected"),
  code: z.string().min(1).max(64),
});
export type DoGatewayControlRejection = z.infer<
  typeof doGatewayControlRejectionSchema
>;
