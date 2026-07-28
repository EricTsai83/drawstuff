import postgres from "postgres";
import { parseWhiteboardDocumentV3 } from "@drawstuff/whiteboard";
import {
  createMigrationManifest,
  finalizeV3Constraints,
  invalidateLegacyShares,
  migrateSceneBatch,
  scanV2Scenes,
  validateSceneBatch,
  verifyV3Database,
  WHITEBOARD_MIGRATION_BATCH_SIZE,
  type ValidatedWhiteboardMigrationRow,
  type WhiteboardMigrationDatabase,
} from "../src/server/whiteboard/migration-v3";
import { compressData, decompressData } from "../src/lib/encode";

const argumentsList = process.argv.slice(2);
const modes = ["--validate", "--execute", "--finalize"].filter((mode) =>
  argumentsList.includes(mode),
);
if (modes.length !== 1) {
  throw new Error(
    "Choose exactly one mode: --validate, --execute, or --finalize",
  );
}
const databaseUrl = process.env.POSTGRES_URL;
if (!databaseUrl) throw new Error("POSTGRES_URL is required");

const sql = postgres(databaseUrl, { max: 1 });
const sceneTable = sql("excalidraw-ericts_scene");
const sharedSceneTable = sql("excalidraw-ericts_shared_scene");
const tombstoneTable = sql("excalidraw-ericts_legacy_shared_scene_tombstone");
const manifestTable = sql("excalidraw-ericts_whiteboard_v3_migration_manifest");

const database: WhiteboardMigrationDatabase = {
  scanV2Scenes: async (afterId, limit) =>
    await sql`
      select id, scene_data as "sceneData"
      from ${sceneTable}
      where document_version = 2
        and id > ${afterId}
      order by id
      limit ${limit}
    `,
  updateSceneToV3: async (id, sceneData) => {
    const updated = await sql`
      update ${sceneTable}
      set scene_data = ${sceneData}, document_version = 3
      where id = ${id} and document_version = 2
      returning id
    `;
    return updated.length === 1;
  },
  invalidateLegacyShares: async () =>
    await sql.begin(async (transaction) => {
      await transaction`
        create table if not exists ${tombstoneTable} (
          shared_scene_id text primary key,
          expired_at timestamp not null default now()
        )
      `;
      const inserted = await transaction`
        insert into ${tombstoneTable} (shared_scene_id, expired_at)
        select shared_scene_id, now()
        from ${sharedSceneTable}
        where document_version = 2
        on conflict (shared_scene_id) do nothing
        returning shared_scene_id
      `;
      await transaction`
        delete from ${sharedSceneTable}
        where document_version = 2
      `;
      return inserted.length;
    }),
  verification: async () => {
    const [counts] = await sql<
      readonly {
        readonly v2SceneCount: number;
        readonly nonV3SceneCount: number;
        readonly v2SharedSceneCount: number;
        readonly nonV3SharedSceneCount: number;
      }[]
    >`
      select
        (select count(*)::int from ${sceneTable} where document_version = 2)
          as "v2SceneCount",
        (select count(*)::int from ${sceneTable} where document_version <> 3)
          as "nonV3SceneCount",
        (select count(*)::int from ${sharedSceneTable} where document_version = 2)
          as "v2SharedSceneCount",
        (select count(*)::int from ${sharedSceneTable} where document_version <> 3)
          as "nonV3SharedSceneCount"
    `;
    if (!counts) throw new Error("Could not verify V3 database");
    const documents = await sql<readonly { readonly sceneData: string }[]>`
      select scene_data as "sceneData"
      from ${sceneTable}
      where document_version = 3 and scene_data is not null
    `;
    let semanticAggregateMatches = true;
    try {
      for (const row of documents) {
        parseWhiteboardDocumentV3(await codec.decode(row.sceneData));
      }
    } catch {
      semanticAggregateMatches = false;
    }
    return { ...counts, semanticAggregateMatches };
  },
  finalizeV3Constraints: async () => {
    await sql.begin(async (transaction) => {
      await transaction`
        alter table ${sceneTable}
        drop constraint if exists scene_document_version_current
      `;
      await transaction`
        alter table ${sceneTable}
        add constraint scene_document_version_current
        check (document_version = 3)
      `;
      await transaction`
        alter table ${sharedSceneTable}
        drop constraint if exists shared_scene_document_version_current
      `;
      await transaction`
        alter table ${sharedSceneTable}
        add constraint shared_scene_document_version_current
        check (document_version = 3)
      `;
    });
  },
};

const codec = {
  decode: async (value: string): Promise<string> => {
    const compressed = Uint8Array.from(Buffer.from(value, "base64"));
    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
    });
    return new TextDecoder().decode(data);
  },
  encode: async (value: string): Promise<string> => {
    const compressed = await compressData(new TextEncoder().encode(value), {});
    return Buffer.from(compressed).toString("base64");
  },
};

try {
  if (modes[0] === "--finalize") {
    await finalizeV3Constraints(database);
    process.stdout.write("Finalized V3-only database constraints\n");
  } else {
    const rows = await scanV2Scenes(database);
    const validated: ValidatedWhiteboardMigrationRow[] = [];
    for (
      let index = 0;
      index < rows.length;
      index += WHITEBOARD_MIGRATION_BATCH_SIZE
    ) {
      validated.push(
        ...(await validateSceneBatch(
          rows.slice(index, index + WHITEBOARD_MIGRATION_BATCH_SIZE),
          codec,
        )),
      );
    }
    const manifest = createMigrationManifest(validated);
    if (modes[0] === "--validate") {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      const suppliedChecksum = readOption("--manifest");
      if (!suppliedChecksum) {
        throw new Error("--execute requires --manifest <checksum>");
      }
      await sql`
        create table if not exists ${manifestTable} (
          checksum text primary key,
          row_count integer not null,
          created_at timestamp not null default now()
        )
      `;
      const stored = await sql<readonly { readonly checksum: string }[]>`
        select checksum from ${manifestTable} limit 1
      `;
      const storedChecksum = stored[0]?.checksum;
      if (
        (storedChecksum && storedChecksum !== suppliedChecksum) ||
        (!storedChecksum && suppliedChecksum !== manifest.checksum)
      ) {
        throw new Error(
          `Manifest checksum mismatch: expected ${manifest.checksum}`,
        );
      }
      if (!storedChecksum) {
        await sql`
          insert into ${manifestTable} (checksum, row_count)
          values (${suppliedChecksum}, ${manifest.rowCount})
        `;
      }
      let migrated = 0;
      for (
        let index = 0;
        index < validated.length;
        index += WHITEBOARD_MIGRATION_BATCH_SIZE
      ) {
        migrated += await sql.begin(
          async (transaction) =>
            await migrateSceneBatch(
              {
                ...database,
                updateSceneToV3: async (id, sceneData) => {
                  const updated = await transaction`
                    update ${sceneTable}
                    set scene_data = ${sceneData}, document_version = 3
                    where id = ${id} and document_version = 2
                    returning id
                  `;
                  return updated.length === 1;
                },
              },
              validated.slice(index, index + WHITEBOARD_MIGRATION_BATCH_SIZE),
            ),
        );
      }
      const invalidated = await invalidateLegacyShares(database);
      await verifyV3Database(database);
      process.stdout.write(
        `Migrated ${migrated} scenes and invalidated ${invalidated} legacy shares\n`,
      );
    }
  }
} finally {
  await sql.end();
}

function readOption(name: string): string | null {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? (argumentsList[index + 1] ?? null) : null;
}
