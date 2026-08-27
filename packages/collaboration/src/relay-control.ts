import { z } from "zod";

import {
  MAX_ROOM_TOKEN_BYTES,
  roomAuthRevisionSchema,
  ROOM_CONTROL_ACTIONS,
} from "./room-auth.ts";

/**
 * Server-to-server control contract between the app backend and a relay
 * provider — the Node relay and the Durable Object gateway.
 *
 * The app pushes a membership or lifecycle change (a signed, single-action
 * control token) and the provider closes the matching sockets. Both sides used
 * to hand-write this contract — the path constant with a "must match" comment
 * and an unvalidated response type — while every WebSocket contract lived in
 * `./relay-protocol.ts`; this module gives the HTTP control channel the same
 * single home. Token claims themselves are in `./room-auth.ts` /
 * `./room-token.ts`.
 */

export const RELAY_CONTROL_PATH = "/control/room";

/**
 * Control bodies carry one token and nothing else. Extra keys are stripped
 * rather than refused, matching how the relay has always read the body.
 */
export const relayControlRequestSchema = z.object({
  token: z.string().min(1),
});
export type RelayControlRequest = z.infer<typeof relayControlRequestSchema>;

/** Successful control response: the applied action and the sockets closed. */
export const relayControlResponseSchema = z.object({
  action: z.enum(ROOM_CONTROL_ACTIONS),
  closed: z.int().nonnegative(),
});
export type RelayControlResponse = z.infer<typeof relayControlResponseSchema>;

/**
 * Durable Object gateway control endpoint. Same push model as the
 * Node relay above, but the room's identity travels inside the verified token
 * claims only — the gateway derives the target Object from them, so the body
 * stays one token with nothing else to trust.
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
