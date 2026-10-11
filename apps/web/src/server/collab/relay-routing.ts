import "server-only";

import { TRPCError } from "@trpc/server";

import { env } from "@/env";

/** Any set value except an explicit off-word enables a safety switch. */
export function isSwitchOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !["0", "false", "off"].includes(raw.trim().toLowerCase());
}

/**
 * The env var is the break-glass override and always wins; otherwise the
 * admin console's runtime switch decides (cached briefly per instance).
 */
export async function collaborationRoomsDisabled(): Promise<boolean> {
  if (isSwitchOn(env.COLLAB_ROOMS_DISABLED)) return true;
  // Imported lazily so modules that only route requests stay free of the DB.
  const { readOpsFlag, COLLAB_ROOMS_DISABLED_KEY } =
    await import("@/server/ops/settings");
  return readOpsFlag(COLLAB_ROOMS_DISABLED_KEY);
}

export function collaborationRoomsDisabledError(): TRPCError {
  return new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message: "Collaboration is temporarily disabled.",
  });
}
