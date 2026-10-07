import "server-only";

import { TRPCError } from "@trpc/server";

import { env } from "@/env";

/** Any set value except an explicit off-word enables a safety switch. */
export function isSwitchOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !["0", "false", "off"].includes(raw.trim().toLowerCase());
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
