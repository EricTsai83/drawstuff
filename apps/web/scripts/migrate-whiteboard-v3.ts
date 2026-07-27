import postgres from "postgres";
import {
  parseWhiteboardDocumentV3,
  serializeWhiteboardDocumentV3,
  type WhiteboardDocumentV3,
} from "@drawstuff/whiteboard";
import {
  migrateWhiteboardDocumentV2,
  parseWhiteboardDocumentV2,
  type WhiteboardDocumentV2,
} from "@drawstuff/whiteboard/migration-v2";
import { compressData, decompressData } from "../src/lib/encode";

const BATCH_SIZE = 100;
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const databaseUrl = process.env.POSTGRES_URL;

if (!databaseUrl) {
  throw new Error("POSTGRES_URL is required");
}

const sql = postgres(databaseUrl, { max: 1 });
const sceneTable = sql("excalidraw-ericts_scene");
const sharedSceneTable = sql("excalidraw-ericts_shared_scene");
const tombstoneTable = sql("excalidraw-ericts_legacy_shared_scene_tombstone");

try {
  if (!dryRun) await prepareCutoverSchema();
  let migrated = 0;
  let lastId = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const batch = await sql<
      readonly {
        readonly id: string;
        readonly scene_data: string | null;
      }[]
    >`
      select id, scene_data
      from ${sceneTable}
      where document_version = 2
        and id > ${lastId}
      order by id
      limit ${BATCH_SIZE}
    `;
    if (batch.length === 0) break;

    const prepared = await Promise.all(
      batch.map(async (row) => {
        if (row.scene_data === null) {
          return { id: row.id, sceneData: null };
        }
        const source = await decompressScene(row.scene_data);
        const v2 = parseWhiteboardDocumentV2(source);
        const v3 = migrateWhiteboardDocumentV2(v2);
        assertSemanticParity(v2, v3);
        parseWhiteboardDocumentV3(v3);
        return {
          id: row.id,
          sceneData: await compressScene(serializeWhiteboardDocumentV3(v3)),
        };
      }),
    );

    if (!dryRun) {
      await sql.begin(async (transaction) => {
        for (const row of prepared) {
          await transaction`
            update ${sceneTable}
            set
              scene_data = ${row.sceneData},
              document_version = 3
            where id = ${row.id}
              and document_version = 2
          `;
        }
      });
    }
    migrated += prepared.length;
    lastId = batch.at(-1)?.id ?? lastId;
    process.stdout.write(`Migrated ${migrated} scenes\n`);
  }

  if (dryRun) {
    const [count] = await sql<readonly { readonly count: number }[]>`
      select count(*)::int as count
      from ${sharedSceneTable}
      where document_version = 2
    `;
    process.stdout.write(
      `Would invalidate ${count?.count ?? 0} legacy shared scenes\n`,
    );
  } else {
    await sql.begin(async (transaction) => {
      await transaction`
        insert into ${tombstoneTable} (
          shared_scene_id,
          expired_at
        )
        select shared_scene_id, now()
        from ${sharedSceneTable}
        where document_version = 2
        on conflict (shared_scene_id) do nothing
      `;
      await transaction`
        delete from ${sharedSceneTable}
        where document_version = 2
      `;
    });
    await finalizeV3Constraints();
  }

  process.stdout.write(
    `${dryRun ? "Validated" : "Migrated"} ${migrated} scene rows\n`,
  );
} finally {
  await sql.end();
}

async function decompressScene(value: string): Promise<string> {
  const compressed = Uint8Array.from(Buffer.from(value, "base64"));
  const { data } = await decompressData<Record<string, never>>(compressed, {
    decryptionKey: "",
  });
  return new TextDecoder().decode(data);
}

async function compressScene(value: string): Promise<string> {
  const compressed = await compressData(new TextEncoder().encode(value), {});
  return Buffer.from(compressed).toString("base64");
}

async function prepareCutoverSchema(): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      create table if not exists ${tombstoneTable} (
        shared_scene_id text primary key,
        expired_at timestamp not null default now()
      )
    `;
    await transaction`
      create index if not exists
        legacy_shared_scene_tombstone_expired_at_idx
      on ${tombstoneTable} (expired_at)
    `;
    await transaction`
      alter table ${sceneTable}
      drop constraint if exists scene_document_version_current
    `;
    await transaction`
      alter table ${sceneTable}
      add constraint scene_document_version_current
      check (document_version in (2, 3))
    `;
    await transaction`
      alter table ${sharedSceneTable}
      drop constraint if exists shared_scene_document_version_current
    `;
    await transaction`
      alter table ${sharedSceneTable}
      add constraint shared_scene_document_version_current
      check (document_version in (2, 3))
    `;
  });
}

async function finalizeV3Constraints(): Promise<void> {
  const [invalidScenes] = await sql<readonly { readonly count: number }[]>`
    select count(*)::int as count
    from ${sceneTable}
    where document_version <> 3
  `;
  const [invalidShares] = await sql<readonly { readonly count: number }[]>`
    select count(*)::int as count
    from ${sharedSceneTable}
    where document_version <> 3
  `;
  if ((invalidScenes?.count ?? 0) > 0 || (invalidShares?.count ?? 0) > 0) {
    throw new Error(
      `Cannot finalize V3 constraints: ${invalidScenes?.count ?? 0} scenes and ${invalidShares?.count ?? 0} shared scenes are not V3`,
    );
  }
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
}

function assertSemanticParity(
  before: WhiteboardDocumentV2,
  after: WhiteboardDocumentV3,
): void {
  assertEqual(
    before.elements.map((element) => element.id),
    after.elements.map((element) => element.id),
    "element IDs/order",
  );
  assertEqual(elementCounts(before), elementCounts(after), "element types");
  assertEqual(
    [
      before.elements.filter((element) => !element.isDeleted).length,
      before.elements.filter((element) => element.isDeleted).length,
    ],
    [
      after.elements.filter((element) => !element.isDeleted).length,
      after.elements.filter((element) => element.isDeleted).length,
    ],
    "active/deleted counts",
  );
  assertEqual(
    referencedAssets(before),
    referencedAssets(after),
    "asset references",
  );
  assertEqual(before.metadata, after.metadata, "metadata");
  assertEqual(documentBounds(before), documentBounds(after), "document bounds");
  assertEqual(
    before.elements.flatMap((element) =>
      element.type === "text" ? [element.text] : [],
    ),
    after.elements.flatMap((element) =>
      element.type === "text" ? [element.text] : [],
    ),
    "text content",
  );
}

function elementCounts(
  document: WhiteboardDocumentV2 | WhiteboardDocumentV3,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const element of document.elements) {
    counts[element.type] = (counts[element.type] ?? 0) + 1;
  }
  return counts;
}

function referencedAssets(
  document: WhiteboardDocumentV2 | WhiteboardDocumentV3,
): readonly string[] {
  return document.elements
    .flatMap((element) =>
      element.type === "image" && element.fileId ? [element.fileId] : [],
    )
    .sort();
}

function documentBounds(
  document: WhiteboardDocumentV2 | WhiteboardDocumentV3,
): readonly number[] | null {
  const active = document.elements.filter((element) => !element.isDeleted);
  if (active.length === 0) return null;
  return [
    Math.min(...active.map((element) => element.x)),
    Math.min(...active.map((element) => element.y)),
    Math.max(...active.map((element) => element.x + element.width)),
    Math.max(...active.map((element) => element.y + element.height)),
  ];
}

function assertEqual(left: unknown, right: unknown, label: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`V2 → V3 semantic mismatch: ${label}`);
  }
}
