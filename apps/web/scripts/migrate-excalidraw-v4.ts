import { createHash } from "node:crypto";
import postgres from "postgres";

import {
  DRAWSTUFF_DOCUMENT_VERSION,
  parseDrawstuffDocument,
  serializeDrawstuffDocumentV4,
} from "../src/lib/excalidraw-document-v4";
import { compressData, decompressData } from "../src/lib/encode";

const argumentsList = process.argv.slice(2);
const modes = ["--inspect", "--validate", "--execute"].filter((mode) =>
  argumentsList.includes(mode),
);

if (modes.length !== 1) {
  throw new Error(
    "Choose exactly one mode: --inspect, --validate, or --execute",
  );
}

const databaseUrl = process.env.POSTGRES_URL;
if (!databaseUrl) throw new Error("POSTGRES_URL is required");

if (
  modes[0] === "--execute" &&
  process.env.DRAWSTUFF_V4_MIGRATION_CONFIRM !==
    "I_HAVE_A_DATABASE_SNAPSHOT_AND_WRITES_ARE_PAUSED"
) {
  throw new Error(
    "--execute requires DRAWSTUFF_V4_MIGRATION_CONFIRM=" +
      "I_HAVE_A_DATABASE_SNAPSHOT_AND_WRITES_ARE_PAUSED",
  );
}

const sql = postgres(databaseUrl, {
  max: 1,
  ...(modes[0] === "--execute" ? {} : { max_lifetime: 10 }),
});
const sceneTable = sql("excalidraw-ericts_scene");
const sharedSceneTable = sql("excalidraw-ericts_shared_scene");

type SceneRow = {
  readonly id: string;
  readonly sceneData: string;
  readonly documentVersion: number;
};

type ValidatedScene = SceneRow & {
  readonly v4SceneData: string;
  readonly semanticDigest: string;
};

try {
  const counts = await inspectCounts();
  if (modes[0] === "--inspect") {
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  } else {
    const rows = await sql<readonly SceneRow[]>`
      select
        id,
        scene_data as "sceneData",
        document_version as "documentVersion"
      from ${sceneTable}
      where document_version in (2, 3)
        and scene_data is not null
      order by id
    `;
    const validated: ValidatedScene[] = [];
    for (const row of rows) validated.push(await validateScene(row));

    const manifest = {
      targetVersion: DRAWSTUFF_DOCUMENT_VERSION,
      rowCount: validated.length,
      checksum: checksum(
        validated.map(({ id, documentVersion, semanticDigest }) => ({
          id,
          documentVersion,
          semanticDigest,
        })),
      ),
      counts,
      encryptedSharedScenes: {
        action: "preserved",
        reason:
          "The decryption key is stored in the URL fragment and is never available to the server.",
      },
    };

    if (modes[0] === "--validate") {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      const suppliedChecksum = readOption("--manifest");
      if (!suppliedChecksum || suppliedChecksum !== manifest.checksum) {
        throw new Error(
          `Manifest checksum mismatch: expected ${manifest.checksum}`,
        );
      }

      let migrated = 0;
      for (const row of validated) {
        const updated = await sql`
          update ${sceneTable}
          set
            scene_data = ${row.v4SceneData},
            document_version = ${DRAWSTUFF_DOCUMENT_VERSION}
          where id = ${row.id}
            and document_version = ${row.documentVersion}
          returning id
        `;
        if (updated.length !== 1) {
          throw new Error(`Concurrent scene update detected for ${row.id}`);
        }
        migrated += 1;
      }

      const after = await inspectCounts();
      process.stdout.write(
        `${JSON.stringify({ migrated, manifest, after }, null, 2)}\n`,
      );
    }
  }
} finally {
  await sql.end();
}

async function inspectCounts() {
  const sceneCounts = await sql<
    readonly { readonly documentVersion: number; readonly count: number }[]
  >`
    select document_version as "documentVersion", count(*)::int as count
    from ${sceneTable}
    group by document_version
    order by document_version
  `;
  const sharedSceneCounts = await sql<
    readonly { readonly documentVersion: number; readonly count: number }[]
  >`
    select document_version as "documentVersion", count(*)::int as count
    from ${sharedSceneTable}
    group by document_version
    order by document_version
  `;
  return { sceneCounts, sharedSceneCounts };
}

async function validateScene(row: SceneRow): Promise<ValidatedScene> {
  const compressed = Uint8Array.from(Buffer.from(row.sceneData, "base64"));
  const { data } = await decompressData<Record<string, never>>(compressed, {
    decryptionKey: "",
  });
  if (!data) throw new Error(`Scene ${row.id} has no document payload`);

  const source = JSON.parse(new TextDecoder().decode(data)) as unknown;
  const document = parseDrawstuffDocument(source);
  const semanticDigest = checksum({
    elements: document.scene.elements,
    assets: document.assets,
  });
  const v4SceneData = Buffer.from(
    await compressData(
      new TextEncoder().encode(serializeDrawstuffDocumentV4(document)),
      {},
    ),
  ).toString("base64");

  const roundTrip = await decodeV4(v4SceneData);
  const roundTripDigest = checksum({
    elements: roundTrip.scene.elements,
    assets: roundTrip.assets,
  });
  if (roundTripDigest !== semanticDigest) {
    throw new Error(`Semantic verification failed for scene ${row.id}`);
  }

  return { ...row, v4SceneData, semanticDigest };
}

async function decodeV4(value: string) {
  const { data } = await decompressData<Record<string, never>>(
    Uint8Array.from(Buffer.from(value, "base64")),
    { decryptionKey: "" },
  );
  if (!data) throw new Error("Encoded V4 document has no payload");
  return parseDrawstuffDocument(
    JSON.parse(new TextDecoder().decode(data)) as unknown,
  );
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readOption(name: string): string | null {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? (argumentsList[index + 1] ?? null) : null;
}
