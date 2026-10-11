import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { opsSetting, opsSignal } from "@/server/db/schema";

export const COLLAB_ROOMS_DISABLED_KEY = "collab-rooms-disabled";

/**
 * How long one instance trusts a flag it read. Collaboration requests already
 * query Neon, so the read adds no wake-up; the cache bounds it to one query
 * per instance per window, and a toggle reaches every instance within it.
 */
const FLAG_CACHE_MS = 15_000;
const flagCache = new Map<string, { value: boolean; at: number }>();

/** A runtime on/off flag; `false` when unset or unreadable. */
export async function readOpsFlag(key: string): Promise<boolean> {
  const cached = flagCache.get(key);
  if (cached && Date.now() - cached.at < FLAG_CACHE_MS) return cached.value;
  let value: boolean;
  try {
    const row = await db.query.opsSetting.findFirst({
      where: eq(opsSetting.key, key),
      columns: { value: true },
    });
    value = row?.value === "on";
  } catch {
    // The switch is a convenience over the env break-glass; an unreadable
    // setting leaves collaboration as it was rather than failing every request.
    return cached?.value ?? false;
  }
  flagCache.set(key, { value, at: Date.now() });
  return value;
}

export async function writeOpsFlag(
  key: string,
  on: boolean,
  actorUserId: string,
): Promise<void> {
  const values = {
    key,
    value: on ? "on" : "off",
    updatedBy: actorUserId,
    updatedAt: new Date(),
  };
  await db
    .insert(opsSetting)
    .values(values)
    .onConflictDoUpdate({ target: opsSetting.key, set: values });
  flagCache.delete(key);
}

/** Per-instance throttle: one write per signal per minute, carrying the count. */
const SIGNAL_FLUSH_MS = 60_000;
const pendingSignals = new Map<string, { count: number; flushedAt: number }>();

/** Counts one occurrence of a fixed-name signal; best effort, never throws. */
export async function recordOpsSignal(name: string): Promise<void> {
  const entry = pendingSignals.get(name) ?? { count: 0, flushedAt: 0 };
  entry.count += 1;
  pendingSignals.set(name, entry);
  if (Date.now() - entry.flushedAt < SIGNAL_FLUSH_MS) return;
  const count = entry.count;
  entry.count = 0;
  entry.flushedAt = Date.now();
  try {
    await db
      .insert(opsSignal)
      .values({ name, count, lastAt: new Date() })
      .onConflictDoUpdate({
        target: opsSignal.name,
        set: { count: sql`${opsSignal.count} + ${count}`, lastAt: new Date() },
      });
  } catch {
    entry.count += count;
  }
}
