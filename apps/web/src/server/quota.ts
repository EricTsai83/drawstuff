import "server-only";

import { and, count, eq, inArray, like, ne, sql } from "drizzle-orm";

import type { Database } from "@/server/collab/rooms";
import { db as defaultDb } from "@/server/db";
import {
  collaborationAsset,
  collaborationRoom,
  fileRecord,
  opsSetting,
  scene,
  sharedScene,
} from "@/server/db/schema";

const MiB = 1024 * 1024;

/**
 * Per-account storage caps, sized so a handful of accounts fit the free
 * tiers (Neon 0.5 GB for documents, shared links and room snapshots;
 * UploadThing 2 GB for images). They are the hard bound the fail-open rate
 * limits rely on. Operators can change each in the admin console
 * (`ops_setting` key `quota:<name>`).
 */
export const QUOTA_DEFAULTS = {
  /** Owned scenes, so empty drafts cannot pile up rows. */
  scenes: 500,
  /** Stored scene documents (Neon). */
  sceneDocumentBytes: 50 * MiB,
  /** Live shared-link documents (Neon; links expire after 30 days). */
  sharedLinkBytes: 50 * MiB,
  /** Scene, shared-link and room images uploaded (UploadThing). */
  imageBytes: 200 * MiB,
  /** Live rooms owned; each holds a snapshot of up to 4 MiB in Neon. */
  activeRooms: 10,
} as const;

export type QuotaName = keyof typeof QUOTA_DEFAULTS;
export type Quotas = Record<QuotaName, number>;

const QUOTA_KEY_PREFIX = "quota:";
const QUOTA_CACHE_MS = 15_000;
let cache: { quotas: Quotas; at: number } | undefined;

function isQuotaName(name: string): name is QuotaName {
  return Object.hasOwn(QUOTA_DEFAULTS, name);
}

/** Current caps: defaults overridden by the console, cached per instance. */
export async function readQuotas(db: Database = defaultDb): Promise<Quotas> {
  if (cache && Date.now() - cache.at < QUOTA_CACHE_MS) return cache.quotas;
  const quotas: Quotas = { ...QUOTA_DEFAULTS };
  const rows = await db
    .select({ key: opsSetting.key, value: opsSetting.value })
    .from(opsSetting)
    .where(like(opsSetting.key, `${QUOTA_KEY_PREFIX}%`));
  for (const row of rows) {
    const name = row.key.slice(QUOTA_KEY_PREFIX.length);
    const value = Number(row.value);
    if (isQuotaName(name) && Number.isSafeInteger(value) && value >= 0)
      quotas[name] = value;
  }
  cache = { quotas, at: Date.now() };
  return quotas;
}

export async function writeQuota(
  db: Database,
  name: QuotaName,
  value: number,
  actorUserId: string,
): Promise<void> {
  const values = {
    key: `${QUOTA_KEY_PREFIX}${name}`,
    value: String(value),
    updatedBy: actorUserId,
    updatedAt: new Date(),
  };
  await db
    .insert(opsSetting)
    .values(values)
    .onConflictDoUpdate({ target: opsSetting.key, set: values });
  cache = undefined;
}

const storedBytes = (column: Parameters<typeof sql>[1]) =>
  sql<number>`coalesce(sum(pg_column_size(${column})), 0)::bigint`.mapWith(
    Number,
  );
const summed = (column: Parameters<typeof sql>[1]) =>
  sql<number>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number);

type UsageOptions = { excludeSceneId?: string };

/**
 * One query per cap. Stored sizes come from `pg_column_size`, which reads the
 * TOAST header instead of the value, so a check is cheap enough for every save.
 */
const usageOf: Record<
  QuotaName,
  (db: Database, userId: string, options: UsageOptions) => Promise<number>
> = {
  scenes: async (db, userId) =>
    (
      await db
        .select({ value: count() })
        .from(scene)
        .where(eq(scene.userId, userId))
    )[0]?.value ?? 0,
  sceneDocumentBytes: async (db, userId, options) =>
    (
      await db
        .select({ value: storedBytes(scene.sceneData) })
        .from(scene)
        .where(
          and(
            eq(scene.userId, userId),
            options.excludeSceneId
              ? ne(scene.id, options.excludeSceneId)
              : undefined,
          ),
        )
    )[0]?.value ?? 0,
  sharedLinkBytes: async (db, userId) =>
    (
      await db
        .select({ value: storedBytes(sharedScene.compressedData) })
        .from(sharedScene)
        .where(eq(sharedScene.ownerId, userId))
    )[0]?.value ?? 0,
  imageBytes: async (db, userId) => {
    const [files, roomImages] = await Promise.all([
      db
        .select({ value: summed(fileRecord.size) })
        .from(fileRecord)
        .where(eq(fileRecord.ownerId, userId)),
      db
        .select({ value: summed(collaborationAsset.byteLength) })
        .from(collaborationAsset)
        .where(eq(collaborationAsset.registeredBy, userId)),
    ]);
    return (files[0]?.value ?? 0) + (roomImages[0]?.value ?? 0);
  },
  activeRooms: async (db, userId) =>
    (
      await db
        .select({ value: count() })
        .from(collaborationRoom)
        .where(
          and(
            eq(collaborationRoom.ownerId, userId),
            inArray(collaborationRoom.status, ["initializing", "ready"]),
          ),
        )
    )[0]?.value ?? 0,
};

/** What an account currently uses against every cap. */
export async function readQuotaUsage(
  db: Database,
  userId: string,
): Promise<Quotas> {
  const names = Object.keys(QUOTA_DEFAULTS) as QuotaName[];
  const values = await Promise.all(
    names.map((name) => usageOf[name](db, userId, {})),
  );
  return Object.fromEntries(
    names.map((name, index) => [name, values[index] ?? 0]),
  ) as Quotas;
}

export class QuotaExceededError extends Error {
  constructor(readonly quota: QuotaName) {
    super("Storage limit reached for this account.");
    this.name = "QuotaExceededError";
  }
}

/**
 * Throws `QuotaExceededError` when adding `amount` (bytes, or 1 for counts)
 * would take the account past the cap. A soft bound: concurrent writes may
 * overshoot by one request each, which the caps' headroom absorbs.
 */
export async function assertWithinQuota(
  db: Database,
  userId: string,
  name: QuotaName,
  amount: number,
  options: UsageOptions = {},
): Promise<void> {
  const [quotas, usage] = await Promise.all([
    readQuotas(db),
    usageOf[name](db, userId, options),
  ]);
  if (usage + amount > quotas[name]) throw new QuotaExceededError(name);
}
