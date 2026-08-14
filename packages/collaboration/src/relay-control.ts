import { z } from "zod";

import { ROOM_CONTROL_ACTIONS } from "./room-auth.ts";

/**
 * Server-to-server control contract between the app backend and the relay.
 *
 * The app pushes a membership or lifecycle change (a signed, single-action
 * control token) and the relay closes the matching sockets. Both sides used to
 * hand-write this contract — the path constant with a "must match" comment and
 * an unvalidated response type — while every WebSocket contract lived in
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
