import "server-only";

import {
  count,
  desc,
  getTableName,
  ne,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { UTApi } from "uploadthing/server";

import { parseMaintenanceReport } from "@/server/admin/maintenance-status";
import type { Database } from "@/server/collab/rooms";
import {
  account,
  adminAuditEvent,
  adminGrant,
  category,
  collaborationAsset,
  collaborationCreationFence,
  collaborationLifecycleRegistration,
  collaborationLifecycleSubject,
  collaborationOperation,
  collaborationProjectionTombstone,
  collaborationRoom,
  collaborationRoomInvite,
  collaborationRoomMember,
  collaborationSnapshot,
  deferredFileCleanup,
  fileRecord,
  maintenanceRun,
  opsSetting,
  opsSignal,
  personalLibrary,
  scene,
  sceneCategory,
  session,
  sharedScene,
  user,
  userDefaultWorkspace,
  userLastActiveWorkspace,
  verification,
  workspace,
} from "@/server/db/schema";

/**
 * How a kind of data is released. The owner's rule: system garbage and
 * bookkeeping go automatically (a maintenance job), user content only by an
 * operator's hand, and anything kept must say why.
 */
type Release =
  | { mode: "auto"; jobs: string[] }
  | { mode: "manual"; place: ManualPlace }
  | { mode: "auto+manual"; jobs: string[]; place: ManualPlace }
  | { mode: "retained" };

/** Where in the console an operator releases it. */
type ManualPlace =
  | "user-page"
  | "room-lookup"
  | "anomalies"
  | "failed-cleanup"
  | "controls"
  | "storage-orphans";

type Store = "neon" | "uploadthing" | "durable-objects";

type CatalogEntry = {
  key: string;
  store: Store;
  /** Neon tables holding the rows (or, for object stores, their metadata). */
  tables: PgTable[];
  /** Total size of the UploadThing objects these rows point at, where recorded. */
  objectBytes?: (db: Database) => Promise<number>;
  release: Release;
};

const summedBytes = (db: Database, column: AnyColumn, table: PgTable) =>
  db
    .select({
      value: sql<number>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number),
    })
    .from(table)
    .then((rows) => rows[0]?.value ?? 0);

/**
 * Every accumulating store and its release path. `tests/admin/data-release.test.ts`
 * fails when a schema table is missing here, so a new table cannot ship
 * without a decided release path.
 */
export const DATA_RELEASE_CATALOG: CatalogEntry[] = [
  {
    key: "accounts",
    store: "neon",
    tables: [
      user,
      account,
      personalLibrary,
      workspace,
      category,
      sceneCategory,
      userDefaultWorkspace,
      userLastActiveWorkspace,
      adminGrant,
    ],
    release: { mode: "manual", place: "user-page" },
  },
  {
    key: "scenes",
    store: "neon",
    tables: [scene],
    release: { mode: "manual", place: "user-page" },
  },
  {
    key: "sceneImages",
    store: "uploadthing",
    tables: [fileRecord],
    objectBytes: (db) => summedBytes(db, fileRecord.size, fileRecord),
    release: {
      mode: "auto+manual",
      jobs: ["unreferenced-asset-gc", "expired-shared-scenes"],
      place: "user-page",
    },
  },
  {
    key: "sharedLinks",
    store: "neon",
    tables: [sharedScene],
    release: {
      mode: "auto+manual",
      jobs: ["expired-shared-scenes"],
      place: "user-page",
    },
  },
  {
    key: "liveRooms",
    store: "neon",
    tables: [collaborationRoom],
    release: {
      mode: "auto+manual",
      jobs: ["record-retention"],
      place: "room-lookup",
    },
  },
  {
    key: "roomContent",
    store: "neon",
    tables: [collaborationSnapshot, collaborationAsset],
    objectBytes: (db) =>
      summedBytes(db, collaborationAsset.byteLength, collaborationAsset),
    release: { mode: "auto", jobs: ["collab-room-retention"] },
  },
  {
    key: "roomPeople",
    store: "neon",
    tables: [
      collaborationRoomMember,
      collaborationRoomInvite,
      collaborationProjectionTombstone,
      collaborationLifecycleRegistration,
    ],
    release: {
      mode: "auto",
      jobs: ["collab-room-retention", "record-retention"],
    },
  },
  {
    key: "operationReceipts",
    store: "neon",
    tables: [collaborationOperation],
    release: { mode: "auto", jobs: ["record-retention"] },
  },
  {
    key: "lifecycleSubjects",
    store: "neon",
    tables: [collaborationLifecycleSubject],
    release: {
      mode: "auto+manual",
      jobs: ["record-retention"],
      place: "anomalies",
    },
  },
  {
    key: "creationFences",
    store: "neon",
    tables: [collaborationCreationFence],
    release: { mode: "retained" },
  },
  {
    key: "cleanupQueue",
    store: "neon",
    tables: [deferredFileCleanup],
    release: {
      mode: "auto+manual",
      jobs: ["drain-cleanup-queue", "purge-finished-queue-rows"],
      place: "failed-cleanup",
    },
  },
  {
    key: "sessions",
    store: "neon",
    tables: [session, verification],
    release: {
      mode: "auto+manual",
      jobs: ["expired-sessions", "expired-verifications"],
      place: "user-page",
    },
  },
  {
    key: "auditLog",
    store: "neon",
    tables: [adminAuditEvent],
    release: { mode: "auto", jobs: ["record-retention"] },
  },
  {
    key: "maintenanceRuns",
    store: "neon",
    tables: [maintenanceRun],
    release: { mode: "auto", jobs: ["record-retention"] },
  },
  {
    key: "operatorSettings",
    store: "neon",
    tables: [opsSetting, opsSignal],
    release: { mode: "manual", place: "controls" },
  },
  {
    key: "storageOrphans",
    store: "uploadthing",
    tables: [],
    release: { mode: "manual", place: "storage-orphans" },
  },
  {
    key: "durableObjects",
    store: "durable-objects",
    tables: [],
    release: {
      mode: "auto+manual",
      jobs: [],
      place: "anomalies",
    },
  },
];

/** Runs searched for each job's latest outcome. */
const RECENT_RUNS = 20;

type JobOutcome = ReturnType<typeof parseMaintenanceReport>[number];

/**
 * Each job's most recent real outcome, newest run first. A dry-run audit
 * (manual retention preview) or a run that omitted the job must not stand
 * in for what the job last actually did.
 */
function latestRealOutcomes(
  runs: { report: string | null }[],
): Map<string, JobOutcome> {
  const outcomes = new Map<string, JobOutcome>();
  for (const run of runs)
    for (const job of parseMaintenanceReport(run.report))
      if (!outcomes.has(job.name) && job.detail?.dryRun !== true)
        outcomes.set(job.name, job);
  return outcomes;
}

const tableStats = (db: Database, table: PgTable) =>
  db
    .select({
      rows: count(),
      bytes:
        sql<number>`pg_total_relation_size(${getTableName(table)}::regclass)`.mapWith(
          Number,
        ),
    })
    .from(table)
    .then((rows) => rows[0] ?? { rows: 0, bytes: 0 });

/** UploadThing's own usage numbers; never throws. */
async function storageUsage() {
  try {
    const usage = await new UTApi().getUsageInfo();
    return {
      available: true as const,
      bytes: usage.appTotalBytes,
      files: usage.filesUploaded,
      limitBytes: usage.limitBytes,
    };
  } catch (error) {
    return {
      available: false as const,
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}

/** The catalog with live sizes and the latest outcome of each release job. */
export async function readDataRelease(db: Database) {
  const tables = DATA_RELEASE_CATALOG.flatMap((entry) => entry.tables);
  const [stats, objectBytes, databaseBytes, lastRun, uploadthing] =
    await Promise.all([
      Promise.all(tables.map((table) => tableStats(db, table))),
      Promise.all(
        DATA_RELEASE_CATALOG.map((entry) =>
          entry.objectBytes ? entry.objectBytes(db) : Promise.resolve(null),
        ),
      ),
      db
        .select({
          bytes: sql<number>`pg_database_size(current_database())`.mapWith(
            Number,
          ),
        })
        .from(sql`(select 1) as one`)
        .then((rows) => rows[0]?.bytes ?? 0),
      db
        .select()
        .from(maintenanceRun)
        .where(ne(maintenanceRun.status, "skipped"))
        .orderBy(desc(maintenanceRun.startedAt))
        .limit(RECENT_RUNS),
      storageUsage(),
    ]);
  const statsByTable = new Map(
    tables.map((table, index) => [table, stats[index]!]),
  );
  const jobs = latestRealOutcomes(lastRun);

  return {
    databaseBytes,
    uploadthing,
    lastRunAt: lastRun[0]?.startedAt ?? null,
    entries: DATA_RELEASE_CATALOG.map((entry, index) => {
      const sized = entry.tables.map((table) => statsByTable.get(table)!);
      return {
        key: entry.key,
        store: entry.store,
        release: entry.release,
        tables: entry.tables.map(getTableName),
        rows: sized.reduce((total, row) => total + row.rows, 0),
        /** Neon relation size (rows plus indexes). */
        databaseBytes: sized.reduce((total, row) => total + row.bytes, 0),
        /** Recorded UploadThing payload size; null where nothing records it. */
        objectBytes: objectBytes[index] ?? null,
        jobs:
          "jobs" in entry.release
            ? entry.release.jobs.map((name) => ({
                name,
                status: jobs.get(name)?.status ?? null,
                error: jobs.get(name)?.error ?? null,
              }))
            : [],
      };
    }),
  };
}
