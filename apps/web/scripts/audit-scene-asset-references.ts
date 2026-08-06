/**
 * Read-only audit of owned-scene asset references (Plans 16/23).
 *
 * For every scene with committed data, resolves the document's referenced
 * Excalidraw file ids against the scene's `file_record` rows and reports:
 *
 * - dangling references: referenced ids with no record (must be 0 before
 *   save-time validation may be enabled)
 * - unreferenced records: rows no committed document references (GC input)
 * - re-save upload cost: bytes/requests a full re-save of every scene would
 *   upload without the saved-file skip
 *
 * Run from apps/web (needs the react-server condition for `server-only`):
 *
 *   pnpm exec tsx --conditions=react-server --env-file=.env \
 *     scripts/audit-scene-asset-references.ts
 */

import postgres from "postgres";

import { readReferencedSceneAssetIds } from "../src/server/scene/referenced-assets";

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("POSTGRES_URL is not set");
  const sql = postgres(url, { max: 1 });

  try {
    const scenes = await sql<
      { id: string; sceneData: string | null }[]
    >`select id, scene_data as "sceneData" from "excalidraw-ericts_scene"`;
    type AssetRecord = {
      sceneId: string;
      excalidrawFileId: string;
      utFileKey: string;
      size: number;
      createdAt: Date;
    };
    const records = await sql<
      AssetRecord[]
    >`select scene_id as "sceneId", excalidraw_file_id as "excalidrawFileId",
             ut_file_key as "utFileKey", size, created_at as "createdAt"
      from "excalidraw-ericts_file_record" where scene_id is not null`;

    const recordsByScene = new Map<string, AssetRecord[]>();
    for (const record of records) {
      const list = recordsByScene.get(record.sceneId) ?? [];
      list.push(record);
      recordsByScene.set(record.sceneId, list);
    }

    let scenesWithData = 0;
    let unreadableScenes = 0;
    let referencedTotal = 0;
    let resaveUploadBytes = 0;
    let resaveUploadRequests = 0;
    const dangling: Array<{ sceneId: string; fileId: string }> = [];
    const unreferenced: Array<{
      sceneId: string;
      fileId: string;
      utFileKey: string;
      size: number;
      createdAt: Date;
    }> = [];

    for (const scene of scenes) {
      const sceneRecords = recordsByScene.get(scene.id) ?? [];
      if (!scene.sceneData) {
        // Draft: references nothing, so every record under it is unreferenced.
        for (const record of sceneRecords) {
          unreferenced.push({
            sceneId: scene.id,
            fileId: record.excalidrawFileId,
            utFileKey: record.utFileKey,
            size: record.size,
            createdAt: record.createdAt,
          });
        }
        continue;
      }
      scenesWithData += 1;
      const referenced = await readReferencedSceneAssetIds(scene.sceneData);
      if (referenced === null) {
        unreadableScenes += 1;
        continue;
      }
      referencedTotal += referenced.size;

      const recordedIds = new Set(
        sceneRecords.map((record) => record.excalidrawFileId),
      );
      for (const fileId of referenced) {
        if (!recordedIds.has(fileId))
          dangling.push({ sceneId: scene.id, fileId });
      }
      for (const record of sceneRecords) {
        if (!referenced.has(record.excalidrawFileId)) {
          unreferenced.push({
            sceneId: scene.id,
            fileId: record.excalidrawFileId,
            utFileKey: record.utFileKey,
            size: record.size,
            createdAt: record.createdAt,
          });
        } else {
          // Without the skip, a re-save uploads these bytes again and then
          // pays a refusal + delete round trip for each.
          resaveUploadBytes += record.size;
          resaveUploadRequests += 1;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          scenes: scenes.length,
          scenesWithData,
          unreadableScenes,
          referencedFileIds: referencedTotal,
          sceneAssetRecords: records.length,
          dangling,
          unreferencedCount: unreferenced.length,
          unreferenced,
          resaveUploadCostWithoutSkip: {
            bytes: resaveUploadBytes,
            uploadRequests: resaveUploadRequests,
            deletionRoundTrips: resaveUploadRequests,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
