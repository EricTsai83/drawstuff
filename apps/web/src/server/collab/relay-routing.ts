import "server-only";

import { TRPCError } from "@trpc/server";

import { doGatewaySocketPath } from "@drawstuff/collaboration/relay-control";

import { env } from "@/env";

/** Any set value except an explicit off-word enables a safety switch. */
export function isSwitchOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !["0", "false", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Every collaboration channel is served by the Durable Object gateway. The
 * client receives an opaque generation-scoped URL and has no provider state.
 */
export function resolveRelayUrl(room: {
  roomId: string;
  authGeneration: number;
}): string {
  return new URL(
    doGatewaySocketPath(room.roomId, room.authGeneration),
    env.COLLAB_RELAY_URL,
  ).toString();
}

export function collaborationRoomsDisabled(): boolean {
  return isSwitchOn(env.COLLAB_ROOMS_DISABLED);
}

export function collaborationRoomsDisabledError(): TRPCError {
  return new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message: "Collaboration is temporarily disabled.",
  });
}
