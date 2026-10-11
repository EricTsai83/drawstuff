import "server-only";

import { desc, eq } from "drizzle-orm";

import { env } from "@/env";
import type { Database } from "@/server/collab/rooms";
import { isSwitchOn } from "@/server/collab/relay-routing";
import { opsSetting, opsSignal } from "@/server/db/schema";
import { COLLAB_ROOMS_DISABLED_KEY } from "@/server/ops/settings";

/** Runtime switches and log-only signals, as the admin console shows them. */
export async function readOpsControls(db: Database) {
  const [setting, signals] = await Promise.all([
    db.query.opsSetting.findFirst({
      where: eq(opsSetting.key, COLLAB_ROOMS_DISABLED_KEY),
    }),
    db.select().from(opsSignal).orderBy(desc(opsSignal.lastAt)),
  ]);
  return {
    collabRoomsDisabled: {
      /** The `COLLAB_ROOMS_DISABLED` env break-glass; it overrides the switch. */
      envOverride: isSwitchOn(env.COLLAB_ROOMS_DISABLED),
      on: setting?.value === "on",
      updatedAt: setting?.updatedAt ?? null,
      updatedBy: setting?.updatedBy ?? null,
    },
    signals,
  };
}
