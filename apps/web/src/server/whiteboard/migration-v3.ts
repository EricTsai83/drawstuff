import { createHash } from "node:crypto";
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

export const WHITEBOARD_MIGRATION_BATCH_SIZE = 100;

export interface WhiteboardMigrationSceneRow {
  readonly id: string;
  readonly sceneData: string | null;
}

export interface ValidatedWhiteboardMigrationRow extends WhiteboardMigrationSceneRow {
  readonly migratedSceneData: string | null;
  readonly sourceChecksum: string;
  readonly targetChecksum: string;
  readonly semanticChecksum: string;
}

export interface WhiteboardMigrationManifest {
  readonly version: 1;
  readonly rowCount: number;
  readonly checksum: string;
  readonly rows: readonly Pick<
    ValidatedWhiteboardMigrationRow,
    "id" | "sourceChecksum" | "targetChecksum" | "semanticChecksum"
  >[];
}

export interface WhiteboardMigrationCodec {
  readonly decode: (value: string) => Promise<string>;
  readonly encode: (value: string) => Promise<string>;
}

export interface WhiteboardMigrationDatabase {
  readonly scanV2Scenes: (
    afterId: string,
    limit: number,
  ) => Promise<readonly WhiteboardMigrationSceneRow[]>;
  readonly updateSceneToV3: (
    id: string,
    sceneData: string | null,
  ) => Promise<boolean>;
  readonly invalidateLegacyShares: () => Promise<number>;
  readonly verification: () => Promise<WhiteboardDatabaseVerification>;
  readonly finalizeV3Constraints: () => Promise<void>;
}

export interface WhiteboardDatabaseVerification {
  readonly v2SceneCount: number;
  readonly nonV3SceneCount: number;
  readonly v2SharedSceneCount: number;
  readonly nonV3SharedSceneCount: number;
  readonly semanticAggregateMatches: boolean;
}

export async function scanV2Scenes(
  database: WhiteboardMigrationDatabase,
): Promise<readonly WhiteboardMigrationSceneRow[]> {
  const rows: WhiteboardMigrationSceneRow[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const batch = await database.scanV2Scenes(
      lastId,
      WHITEBOARD_MIGRATION_BATCH_SIZE,
    );
    if (batch.length === 0) return rows;
    rows.push(...batch);
    lastId = batch.at(-1)?.id ?? lastId;
  }
}

export async function validateSceneBatch(
  rows: readonly WhiteboardMigrationSceneRow[],
  codec: WhiteboardMigrationCodec,
): Promise<readonly ValidatedWhiteboardMigrationRow[]> {
  return await Promise.all(
    rows.map(async (row) => {
      if (row.sceneData === null) {
        const checksum = sha256("null");
        return {
          ...row,
          migratedSceneData: null,
          sourceChecksum: checksum,
          targetChecksum: checksum,
          semanticChecksum: checksum,
        };
      }
      const decoded = await codec.decode(row.sceneData);
      const source = parseWhiteboardDocumentV2(decoded);
      const migrated = migrateWhiteboardDocumentV2(source);
      assertSemanticParity(source, migrated);
      const serialized = serializeWhiteboardDocumentV3(migrated);
      const reparsed = parseWhiteboardDocumentV3(serialized);
      assertSemanticParity(source, reparsed);
      return {
        ...row,
        migratedSceneData: await codec.encode(serialized),
        sourceChecksum: sha256(decoded),
        targetChecksum: sha256(serialized),
        semanticChecksum: sha256(JSON.stringify(semanticSummary(source))),
      };
    }),
  );
}

export function createMigrationManifest(
  rows: readonly ValidatedWhiteboardMigrationRow[],
): WhiteboardMigrationManifest {
  const manifestRows = rows
    .map(({ id, sourceChecksum, targetChecksum, semanticChecksum }) => ({
      id,
      sourceChecksum,
      targetChecksum,
      semanticChecksum,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: 1,
    rowCount: manifestRows.length,
    checksum: sha256(JSON.stringify(manifestRows)),
    rows: manifestRows,
  };
}

export async function migrateSceneBatch(
  database: WhiteboardMigrationDatabase,
  rows: readonly ValidatedWhiteboardMigrationRow[],
): Promise<number> {
  let migrated = 0;
  for (const row of rows) {
    if (await database.updateSceneToV3(row.id, row.migratedSceneData)) {
      migrated += 1;
    }
  }
  return migrated;
}

export async function invalidateLegacyShares(
  database: WhiteboardMigrationDatabase,
): Promise<number> {
  return await database.invalidateLegacyShares();
}

export async function verifyV3Database(
  database: WhiteboardMigrationDatabase,
): Promise<WhiteboardDatabaseVerification> {
  const verification = await database.verification();
  if (
    verification.v2SceneCount > 0 ||
    verification.nonV3SceneCount > 0 ||
    verification.v2SharedSceneCount > 0 ||
    verification.nonV3SharedSceneCount > 0 ||
    !verification.semanticAggregateMatches
  ) {
    throw new Error(
      `V3 database verification failed: ${JSON.stringify(verification)}`,
    );
  }
  return verification;
}

export async function finalizeV3Constraints(
  database: WhiteboardMigrationDatabase,
): Promise<void> {
  await verifyV3Database(database);
  await database.finalizeV3Constraints();
}

function assertSemanticParity(
  before: WhiteboardDocumentV2,
  after: WhiteboardDocumentV3,
): void {
  const beforeSummary = semanticSummary(before);
  const afterSummary = semanticSummary(after);
  if (JSON.stringify(beforeSummary) !== JSON.stringify(afterSummary)) {
    throw new Error("V2 → V3 semantic mismatch");
  }
}

function semanticSummary(
  document: WhiteboardDocumentV2 | WhiteboardDocumentV3,
) {
  const active = document.elements.filter((element) => !element.isDeleted);
  return {
    ids: document.elements.map((element) => element.id),
    types: elementCounts(document),
    deleted: document.elements.length - active.length,
    active: active.length,
    assets: document.elements
      .flatMap((element) =>
        element.type === "image" && element.fileId ? [element.fileId] : [],
      )
      .sort(),
    metadata: document.metadata,
    bounds:
      active.length === 0
        ? null
        : [
            Math.min(...active.map((element) => element.x)),
            Math.min(...active.map((element) => element.y)),
            Math.max(...active.map((element) => element.x + element.width)),
            Math.max(...active.map((element) => element.y + element.height)),
          ],
    text: document.elements.flatMap((element) =>
      element.type === "text" ? [element.text] : [],
    ),
  };
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
