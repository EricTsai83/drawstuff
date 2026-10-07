import { is, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import {
  generateDrizzleJson,
  generateMigration,
  type DrizzleSnapshotJSON,
} from "drizzle-kit/api";

/** Schema artifacts only: this module opens no database connection. */
export async function collaborationDDL(schema: Record<string, unknown>) {
  const tables = Object.fromEntries(
    Object.entries(schema).filter(
      ([, value]) =>
        is(value, PgTable) &&
        getTableName(value).startsWith("drawstuff_collaboration_"),
    ),
  );
  const empty: unknown = generateDrizzleJson({});
  const snapshot: unknown = generateDrizzleJson(tables);
  return {
    names: Object.values(tables)
      .map((value) => getTableName(value as PgTable))
      .sort(),
    statements: await generateMigration(
      empty as DrizzleSnapshotJSON,
      snapshot as DrizzleSnapshotJSON,
    ),
  };
}
export function resetDDL(names: string[], statements: string[]) {
  if (names.some((name) => !/^drawstuff_collaboration_[a-z_]+$/.test(name)))
    throw new Error("non-collaboration-table");
  // One DROP handles internal FKs. Deliberately no CASCADE: external references must stop the reset.
  return [
    `DROP TABLE IF EXISTS ${[...new Set(names)].map((name) => `"${name}"`).join(", ")};`,
    ...statements,
  ];
}
