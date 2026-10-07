import { createHash } from "node:crypto";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { z } from "zod";

const fingerprintSchema = z.object({
  table: z.string(),
  rows: z.string(),
  digest: z.string(),
});
export const resetReportSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["before", "after"]),
  target: z.string(),
  capturedAt: z.string(),
  readOnly: z.literal(true),
  personal: z.array(fingerprintSchema),
  columns: z.array(
    z.object({
      table: z.string(),
      column: z.string(),
      type: z.string(),
      nullable: z.boolean(),
    }),
  ),
  constraints: z.array(
    z.object({ table: z.string(), name: z.string(), definition: z.string() }),
  ),
  indexes: z.array(
    z.object({ table: z.string(), name: z.string(), definition: z.string() }),
  ),
  externalReferences: z.array(
    z.object({ table: z.string(), name: z.string(), definition: z.string() }),
  ),
  objectKeys: z.array(z.string()),
  oldRoomNames: z.array(z.string()),
});
type ResetReport = z.infer<typeof resetReportSchema>;
type Column = ResetReport["columns"][number];
type Definition = ResetReport["constraints"][number];

/** Only fixed, non-sensitive operator messages may cross the CLI error boundary. */
export class ResetCheckError extends Error {}

const normalizeType = (type: string): string =>
  type
    .replace("character varying", "varchar")
    .replace("timestamp without time zone", "timestamp")
    .replace("timestamp with time zone", "timestamptz");

/** No database mutation: all reads share a repeatable-read, read-only transaction. */
export async function inspectResetDatabase(
  client: Sql,
  connectionUrl: string,
  phase: ResetReport["phase"],
  expectedSchema: Record<string, unknown>,
  manifestStatements: string[],
): Promise<ResetReport> {
  const url = new URL(connectionUrl);
  const target = createHash("sha256")
    .update(
      `${url.hostname}:${url.port}${url.pathname}?options=${url.searchParams.get("options") ?? ""}`,
    )
    .digest("hex");
  return client.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL search_path = pg_catalog, public`;
      const [mode] = await tx<
        { read_only: string }[]
      >`SELECT current_setting('transaction_read_only') AS read_only`;
      if (mode?.read_only !== "on")
        throw new ResetCheckError("Read-only transaction required");
      const columns = await tx<Column[]>`
      SELECT t.relname AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type,
             NOT a.attnotnull AS nullable
      FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid
      WHERE n.nspname='public' AND t.relkind='r' AND starts_with(t.relname,'drawstuff_collaboration_')
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY t.relname,a.attname`;
      const expected: Column[] = Object.values(expectedSchema)
        .filter((value) => is(value, PgTable))
        .flatMap((table) => {
          const config = getTableConfig(table);
          return config.name.startsWith("drawstuff_collaboration_")
            ? config.columns.map((column) => ({
                table: config.name,
                column: column.name,
                type: normalizeType(column.getSQLType()),
                nullable: !column.notNull,
              }))
            : [];
        })
        .sort(
          (a, b) =>
            a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
        );
      const actual = columns
        .map((column) => ({ ...column, type: normalizeType(column.type) }))
        .sort(
          (a, b) =>
            a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
        );
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new ResetCheckError(
          "Collaboration tables/columns/types/nullability differ from the expected phase; inspect actual schema before reset",
        );
      }
      const constraints = await tx<Definition[]>`
      SELECT t.relname AS "table", c.conname AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND starts_with(t.relname,'drawstuff_collaboration_') ORDER BY t.relname,c.conname`;
      const indexes = await tx<Definition[]>`
      SELECT tablename AS "table",indexname AS name,indexdef AS definition FROM pg_indexes
      WHERE schemaname='public' AND starts_with(tablename,'drawstuff_collaboration_') ORDER BY tablename,indexname`;
      const externalReferences = await tx<Definition[]>`
      SELECT source.relname AS "table",c.conname AS name,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
      JOIN pg_namespace n ON n.oid=target.relnamespace
      WHERE c.contype='f' AND n.nspname='public' AND starts_with(target.relname,'drawstuff_collaboration_')
        AND NOT (source.relnamespace=target.relnamespace AND starts_with(source.relname,'drawstuff_collaboration_'))
      ORDER BY source.relname,c.conname`;
      if (externalReferences.length)
        throw new ResetCheckError(
          "External foreign keys reference collaboration tables; stop and review before reset",
        );
      const tables = await tx<{ table: string }[]>`
      SELECT tablename AS "table" FROM pg_tables WHERE schemaname='public'
        AND starts_with(tablename,'drawstuff_') AND NOT starts_with(tablename,'drawstuff_collaboration_') ORDER BY tablename`;
      const personal: ResetReport["personal"] = [];
      for (const { table } of tables) {
        const [fingerprint] = await tx<{ rows: string; digest: string }[]>`
        SELECT count(*)::text AS rows,
          md5(COALESCE(string_agg(row_digest,'' ORDER BY row_digest),'')) AS digest
        FROM (SELECT md5(to_jsonb(t)::text) AS row_digest FROM ${tx(`public.${table}`)} t) hashes`;
        if (!fingerprint)
          throw new ResetCheckError("Missing preservation fingerprint");
        personal.push({ table, ...fingerprint });
      }
      let objectKeys: string[] = [];
      let oldRoomNames: string[] = [];
      if (phase === "before") {
        if (manifestStatements.length !== 2)
          throw new ResetCheckError(
            "Expected two reviewed manifest statements",
          );
        objectKeys = (
          await tx.unsafe<{ ut_file_key: string }[]>(manifestStatements[0]!)
        )
          .map((row) => row.ut_file_key)
          .sort();
        oldRoomNames = (
          await tx.unsafe<{ old_do_name: string }[]>(manifestStatements[1]!)
        )
          .map((row) => row.old_do_name)
          .sort();
      }
      return {
        version: 1,
        phase,
        target,
        capturedAt: new Date().toISOString(),
        readOnly: true,
        personal,
        columns,
        constraints,
        indexes,
        externalReferences,
        objectKeys,
        oldRoomNames,
      };
    },
  );
}

export function compareResetReports(
  before: ResetReport,
  after: ResetReport,
): void {
  if (
    before.phase !== "before" ||
    after.phase !== "after" ||
    before.target !== after.target
  ) {
    throw new ResetCheckError(
      "Baseline must be a before report from the same database endpoint",
    );
  }
  if (JSON.stringify(before.personal) !== JSON.stringify(after.personal)) {
    throw new ResetCheckError(
      "Non-collaboration tables changed; keep maintenance active and investigate",
    );
  }
}
