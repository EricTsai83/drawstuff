/**
 * One-time plan 21 data wipe (docs/operations/collaboration-do-deployment.md
 * §6). Every subcommand is a dry run unless `--apply` is given, and reads the
 * database only from PLAN21_DATABASE_URL — never an application env var.
 *
 *   uploads [--apply]  Inventory UploadThing; delete room image objects.
 *   tables  [--apply]  Count, then empty, the room tables.
 *   schema  [--apply]  Show, then apply, the room tables' new schema
 *                      (drop + create; refuses while any room table has rows).
 *
 * Run order: uploads → tables → schema. Reports go to <repo>/.local/plan21/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import {
  generateDrizzleJson,
  generateMigration,
  type DrizzleSnapshotJSON,
} from "drizzle-kit/api";
import postgres from "postgres";
import { UTApi } from "uploadthing/server";

import * as schema from "../src/server/db/schema";

/** Room data only. The account/scene lifecycle table pairs with the Lifecycle Objects and stays. */
const ROOM_TABLES = [
  "drawstuff_collaboration_room_member",
  "drawstuff_collaboration_room_invite",
  "drawstuff_collaboration_snapshot",
  "drawstuff_collaboration_asset",
  "drawstuff_collaboration_operation",
  "drawstuff_collaboration_projection_tombstone",
  "drawstuff_collaboration_lifecycle_registration",
  "drawstuff_collaboration_creation_fence",
  "drawstuff_collaboration_room",
] as const;
const DELETE_BATCH = 100;

const [command, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
const databaseUrl = process.env.PLAN21_DATABASE_URL;
if (!databaseUrl || !["uploads", "tables", "schema"].includes(command ?? "")) {
  console.error(
    "Usage: PLAN21_DATABASE_URL=… pnpm plan21:wipe uploads|tables|schema [--apply]",
  );
  process.exit(1);
}
const reports = resolve(import.meta.dirname, "../../../.local/plan21");
const client = postgres(databaseUrl, { max: 1 });

async function report(name: string, value: unknown): Promise<string> {
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const path = resolve(
    reports,
    `${name}-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  return path;
}

/** Room object keys no personal file, thumbnail or published page references. */
async function roomObjectKeys(): Promise<string[]> {
  const rows = await client<{ key: string }[]>`
    SELECT DISTINCT r.key FROM (
      SELECT ut_file_key AS key FROM drawstuff_collaboration_asset
      UNION
      SELECT ut_file_key FROM drawstuff_collaboration_operation WHERE ut_file_key IS NOT NULL
      UNION
      -- Room cleanups that gave up: maintenance never retries a failed row.
      SELECT ut_file_key FROM drawstuff_deferred_file_cleanup
      WHERE status = 'failed' AND reason LIKE 'collab-%'
    ) r
    WHERE NOT EXISTS (SELECT 1 FROM drawstuff_file_record f WHERE f.ut_file_key = r.key)
      AND NOT EXISTS (SELECT 1 FROM drawstuff_scene s
        WHERE s.thumbnail_file_key = r.key OR s.published_svg_key = r.key)
      -- Still queued: the maintenance drain deletes these.
      AND NOT EXISTS (SELECT 1 FROM drawstuff_deferred_file_cleanup d
        WHERE d.ut_file_key = r.key AND d.status = 'pending')
    ORDER BY r.key`;
  return rows.map((row) => row.key);
}

/**
 * Keys something other than room data still owns, or a cleanup still pending.
 * Done and failed cleanups are not "known": an object they name that still
 * exists is reported for review.
 */
async function otherKnownKeys(): Promise<Set<string>> {
  const rows = await client<{ key: string }[]>`
    SELECT ut_file_key AS key FROM drawstuff_file_record
    UNION SELECT thumbnail_file_key FROM drawstuff_scene WHERE thumbnail_file_key IS NOT NULL
    UNION SELECT published_svg_key FROM drawstuff_scene WHERE published_svg_key IS NOT NULL
    UNION SELECT ut_file_key FROM drawstuff_deferred_file_cleanup WHERE status = 'pending'`;
  return new Set(rows.map((row) => row.key));
}

async function uploads(): Promise<void> {
  const utapi = new UTApi();
  const roomKeys = await roomObjectKeys();
  const room = new Set(roomKeys);
  const known = await otherKnownKeys();
  const unknown: {
    key: string;
    name: string;
    size: number;
    uploadedAt: string;
  }[] = [];
  let total = 0;
  for (let offset = 0; ; offset += 500) {
    const page = await utapi.listFiles({ limit: 500, offset });
    for (const file of page.files) {
      total += 1;
      if (!room.has(file.key) && !known.has(file.key))
        unknown.push({
          key: file.key,
          name: file.name,
          size: file.size,
          uploadedAt: new Date(file.uploadedAt).toISOString(),
        });
    }
    if (!page.hasMore) break;
  }
  const inventory = await report("uploads-inventory", {
    roomKeys,
    unknown,
    counts: {
      uploadThing: total,
      room: roomKeys.length,
      unknown: unknown.length,
    },
  });
  console.log(
    `UploadThing objects: ${total}. Room objects to delete: ${roomKeys.length}. ` +
      `Not referenced by anything known (review by hand, never deleted here): ${unknown.length}.`,
  );
  console.log(`Inventory: ${inventory}`);
  if (!apply) {
    console.log("Dry run: re-run with --apply to delete the room objects.");
    return;
  }
  let deleted = 0;
  for (let index = 0; index < roomKeys.length; index += DELETE_BATCH) {
    const batch = roomKeys.slice(index, index + DELETE_BATCH);
    const result = await utapi.deleteFiles(batch);
    if (!result.success)
      throw new Error(
        `Delete batch at ${index} failed; ${deleted} deleted so far.`,
      );
    deleted += result.deletedCount;
  }
  const outcome = await report("uploads-deleted", {
    requested: roomKeys.length,
    deleted,
  });
  console.log(`Deleted ${deleted} of ${roomKeys.length}. Result: ${outcome}`);
}

async function existingRoomTables(): Promise<string[]> {
  const rows = await client<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${[...ROOM_TABLES]})`;
  return ROOM_TABLES.filter((name) => rows.some((row) => row.name === name));
}

async function countRows(tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${client(table)}`;
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

async function tables(): Promise<void> {
  const present = await existingRoomTables();
  const before = await countRows(present);
  console.log("Room table rows:", before);
  if (!apply) {
    console.log("Dry run: re-run with --apply to empty these tables.");
    return;
  }
  // One statement, so it is atomic. No CASCADE: a table outside this list
  // that still references one of them makes it fail instead of spreading.
  await client.unsafe(
    `TRUNCATE TABLE ${present.map((t) => `"${t}"`).join(", ")}`,
  );
  const after = await countRows(present);
  const outcome = await report("tables-emptied", { before, after });
  console.log("After:", after, `Result: ${outcome}`);
}

/**
 * The room tables are empty after `tables`, so they are dropped and created
 * from the current schema in one transaction. Only these nine tables appear in
 * the DDL; the lifecycle table and everything else are never touched.
 */
async function schemaChange(): Promise<void> {
  const present = await existingRoomTables();
  const counts = await countRows(present);
  const nonEmpty = Object.entries(counts).filter(([, rows]) => rows > 0);
  const roomTables = Object.fromEntries(
    Object.entries(schema).filter(
      ([, value]) =>
        is(value, PgTable) &&
        (ROOM_TABLES as readonly string[]).includes(getTableName(value)),
    ),
  );
  const empty: unknown = generateDrizzleJson({});
  const target: unknown = generateDrizzleJson(roomTables);
  const create = await generateMigration(
    empty as DrizzleSnapshotJSON,
    target as DrizzleSnapshotJSON,
  );
  // Dependents first; ROOM_TABLES lists the room table last.
  const drop = present.map((table) => `DROP TABLE "${table}"`);
  const plan = await report("schema-plan", { counts, drop, create });
  console.log([...drop, ...create].join(";\n"));
  console.log(`Plan: ${plan}`);
  if (nonEmpty.length > 0) {
    console.error(
      "Refusing: room tables still hold rows. Run `tables --apply` first.",
      nonEmpty,
    );
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log("Dry run: re-run with --apply to execute these statements.");
    return;
  }
  await client.begin(async (tx) => {
    // Recheck under exclusive locks: a late writer must make this refuse,
    // never have its rows dropped.
    await tx.unsafe(
      `LOCK TABLE ${present.map((t) => `"${t}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`,
    );
    for (const table of present) {
      const [row] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ${tx(table)}`;
      if ((row?.count ?? 0) > 0)
        throw new Error(`Refusing: ${table} gained rows; nothing was changed.`);
    }
    for (const statement of [...drop, ...create]) await tx.unsafe(statement);
  });
  console.log("Applied.");
}

try {
  if (command === "uploads") await uploads();
  else if (command === "tables") await tables();
  else await schemaChange();
} finally {
  await client.end();
}
