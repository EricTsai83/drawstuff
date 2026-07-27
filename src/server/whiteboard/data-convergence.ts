import "server-only";

import { createHash } from "node:crypto";
import { and, asc, count, eq, gt, isNull, ne, or } from "drizzle-orm";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import {
  convertPersistedWhiteboardDocumentToV2,
  createPersistedWhiteboardDocumentV2,
  createWhiteboardDocumentV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  WHITEBOARD_DOCUMENT_VERSION,
  WhiteboardDocumentError,
  type WhiteboardAsset,
  type WhiteboardAssetV2,
  type WhiteboardDocumentV2,
} from "@/features/whiteboard";
import {
  base64ToArrayBuffer,
  compressData,
  decompressData,
} from "@/lib/encode";
import { db } from "@/server/db";
import { scene, sharedScene } from "@/server/db/schema";
import { MAX_DECOMPRESSED_SCENE_BYTES } from "./persistence-guard";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const MAX_DECOMPRESSED_ASSET_BYTES = FILE_UPLOAD_MAX_BYTES * 8;

export interface WhiteboardConvergenceFileRecord {
  readonly name: string;
  readonly url: string;
  readonly contentHash: string | null;
  readonly createdAt: Date;
}

export interface WhiteboardConvergenceScene {
  readonly id: string;
  readonly revision: number;
  readonly sceneData: string | null;
  readonly documentVersion: number | null;
  readonly fileRecords: readonly WhiteboardConvergenceFileRecord[];
}

export interface WhiteboardConvergenceAudit {
  readonly rowHash: string;
  readonly revision: number;
  readonly sourceFormat:
    | "draft"
    | "legacy-excalidraw"
    | "unknown"
    | "whiteboard-v1"
    | "whiteboard-v2";
  readonly outcome:
    "conflict" | "converted" | "current" | "failed" | "would-convert";
  readonly payloadHashBefore: string | null;
  readonly payloadHashAfter: string | null;
  readonly semanticHash: string | null;
  readonly assetRelationshipHash: string;
  readonly elementCount: number;
  readonly referencedAssetCount: number;
  readonly errorCode?: string;
}

export interface PreparedWhiteboardConvergence {
  readonly audit: Omit<WhiteboardConvergenceAudit, "outcome">;
  readonly candidate: boolean;
  readonly nextSceneData: string | null;
}

export interface WhiteboardConvergenceBatchResult {
  readonly audits: readonly WhiteboardConvergenceAudit[];
  readonly stoppedAfterFailure: boolean;
  readonly nextCursor: string | null;
  readonly retryFrom?: string | null;
  readonly hasMore: boolean;
}

export interface WhiteboardConvergenceReadiness {
  readonly legacyDatabaseDocuments: number;
  readonly legacySharedDocuments: number;
}

type FetchAsset = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface FileMetadata {
  readonly [key: string]: unknown;
  readonly id?: unknown;
  readonly mimeType?: unknown;
  readonly created?: unknown;
  readonly lastRetrieved?: unknown;
}

export async function prepareWhiteboardSceneConvergence(
  row: WhiteboardConvergenceScene,
  fetchAsset: FetchAsset = fetch,
): Promise<PreparedWhiteboardConvergence> {
  const rowHash = hashText(row.id);
  const assetRelationshipHash = hashText(
    row.fileRecords
      .map(
        (record) =>
          `${record.name}:${record.contentHash ?? ""}:${record.createdAt.toISOString()}`,
      )
      .sort()
      .join("\n"),
  );
  const candidate = row.documentVersion !== WHITEBOARD_DOCUMENT_VERSION;

  if (row.sceneData === null) {
    return {
      candidate,
      nextSceneData: null,
      audit: {
        rowHash,
        revision: row.revision,
        sourceFormat: "draft",
        payloadHashBefore: null,
        payloadHashAfter: null,
        semanticHash: null,
        assetRelationshipHash,
        elementCount: 0,
        referencedAssetCount: 0,
      },
    };
  }

  const decodedSource = await decodeSceneData(row.sceneData);
  const converted = convertPersistedWhiteboardDocumentToV2(decodedSource, {
    externalAssets: true,
  });
  const hydrated = await hydrateAndVerifyExternalAssets(
    converted.document,
    row.fileRecords,
    fetchAsset,
  );
  const canonicalSource = serializeWhiteboardDocumentV2(hydrated);
  parseWhiteboardDocumentV2(canonicalSource);

  const referencedAssetIds = collectReferencedAssetIds(hydrated);
  const semanticHash = hashText(
    JSON.stringify({
      elements: hydrated.elements,
      metadata: hydrated.metadata,
      referencedAssetIds,
    }),
  );
  const nextCompressed = await compressData(
    new TextEncoder().encode(canonicalSource),
    {},
  );
  const nextSceneData = Buffer.from(nextCompressed).toString("base64");

  return {
    candidate,
    nextSceneData,
    audit: {
      rowHash,
      revision: row.revision,
      sourceFormat: converted.report.sourceFormat,
      payloadHashBefore: hashText(decodedSource),
      payloadHashAfter: hashText(canonicalSource),
      semanticHash,
      assetRelationshipHash,
      elementCount: hydrated.elements.length,
      referencedAssetCount: referencedAssetIds.length,
    },
  };
}

export async function runWhiteboardConvergenceBatch(options: {
  readonly apply: boolean;
  readonly cursor?: string;
  readonly batchSize?: number;
  readonly abortAfterFailures?: number;
  readonly fetchAsset?: FetchAsset;
}): Promise<WhiteboardConvergenceBatchResult> {
  const batchSize = Math.min(
    Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1),
    MAX_BATCH_SIZE,
  );
  const abortAfterFailures = Math.max(options.abortAfterFailures ?? 1, 1);
  const rows = await db.query.scene.findMany({
    ...(options.cursor ? { where: gt(scene.id, options.cursor) } : {}),
    orderBy: [asc(scene.id)],
    limit: batchSize + 1,
    columns: {
      id: true,
      revision: true,
      sceneData: true,
      documentVersion: true,
    },
    with: {
      fileRecords: {
        columns: {
          name: true,
          url: true,
          contentHash: true,
          createdAt: true,
        },
      },
    },
  });
  const hasMore = rows.length > batchSize;
  const batch = rows.slice(0, batchSize);
  const audits: WhiteboardConvergenceAudit[] = [];
  let failureCount = 0;
  let nextCursor = options.cursor ?? null;
  let retryFrom: string | null | undefined;
  let stoppedAfterFailure = false;

  for (const row of batch) {
    const cursorBeforeRow = nextCursor;
    try {
      const prepared = await prepareWhiteboardSceneConvergence(
        row,
        options.fetchAsset,
      );
      if (!prepared.candidate) {
        audits.push({ ...prepared.audit, outcome: "current" });
        nextCursor = row.id;
        continue;
      }
      if (!options.apply) {
        audits.push({ ...prepared.audit, outcome: "would-convert" });
        nextCursor = row.id;
        continue;
      }

      const originalVersion = row.documentVersion as number | null;
      const originalData = row.sceneData;
      const [updated] = await db
        .update(scene)
        .set({
          sceneData: prepared.nextSceneData,
          documentVersion: WHITEBOARD_DOCUMENT_VERSION,
        })
        .where(
          and(
            eq(scene.id, row.id),
            eq(scene.revision, row.revision),
            originalData === null
              ? isNull(scene.sceneData)
              : eq(scene.sceneData, originalData),
            originalVersion === null
              ? isNull(scene.documentVersion)
              : eq(scene.documentVersion, originalVersion),
          ),
        )
        .returning({ id: scene.id });
      if (!updated) {
        audits.push({ ...prepared.audit, outcome: "conflict" });
      } else {
        audits.push({ ...prepared.audit, outcome: "converted" });
      }
      nextCursor = row.id;
    } catch (error: unknown) {
      failureCount += 1;
      if (retryFrom === undefined) {
        retryFrom = cursorBeforeRow;
      }
      audits.push({
        rowHash: hashText(row.id),
        revision: row.revision,
        sourceFormat: "unknown",
        outcome: "failed",
        payloadHashBefore: row.sceneData ? hashText(row.sceneData) : null,
        payloadHashAfter: null,
        semanticHash: null,
        assetRelationshipHash: hashText(
          row.fileRecords
            .map(
              (record) =>
                `${record.name}:${record.contentHash ?? ""}:${record.createdAt.toISOString()}`,
            )
            .sort()
            .join("\n"),
        ),
        elementCount: 0,
        referencedAssetCount: 0,
        errorCode: classifyConvergenceError(error),
      });
      if (failureCount >= abortAfterFailures) {
        stoppedAfterFailure = true;
        nextCursor = row.id;
        break;
      }
      nextCursor = row.id;
    }
  }

  return {
    audits,
    stoppedAfterFailure,
    nextCursor,
    ...(retryFrom === undefined ? {} : { retryFrom }),
    hasMore: stoppedAfterFailure || hasMore,
  };
}

export async function getWhiteboardConvergenceReadiness(): Promise<WhiteboardConvergenceReadiness> {
  const [databaseResult, sharedResult] = await Promise.all([
    db
      .select({ value: count() })
      .from(scene)
      .where(
        or(
          isNull(scene.documentVersion),
          ne(scene.documentVersion, WHITEBOARD_DOCUMENT_VERSION),
        ),
      ),
    db
      .select({ value: count() })
      .from(sharedScene)
      .where(
        or(
          isNull(sharedScene.documentVersion),
          ne(sharedScene.documentVersion, WHITEBOARD_DOCUMENT_VERSION),
        ),
      ),
  ]);
  return {
    legacyDatabaseDocuments: databaseResult[0]?.value ?? 0,
    legacySharedDocuments: sharedResult[0]?.value ?? 0,
  };
}

async function hydrateAndVerifyExternalAssets(
  document: WhiteboardDocumentV2,
  fileRecords: readonly WhiteboardConvergenceFileRecord[],
  fetchAsset: FetchAsset,
): Promise<WhiteboardDocumentV2> {
  const recordsByAssetId = new Map<string, WhiteboardConvergenceFileRecord>();
  for (const record of fileRecords) {
    const existing = recordsByAssetId.get(record.name);
    if (!existing || existing.createdAt < record.createdAt) {
      recordsByAssetId.set(record.name, record);
    }
  }
  const entries = await Promise.all(
    Object.entries(document.assets).map(async ([id, asset]) => {
      if (asset.storage !== "external") return [id, asset] as const;
      const record = recordsByAssetId.get(id);
      if (!record) {
        throw new Error(`MISSING_ASSET_RECORD:${hashText(id)}`);
      }
      const verifiedAsset = await readExternalAsset(record, fetchAsset);
      if (verifiedAsset.id !== id) {
        throw new Error("ASSET_ID_MISMATCH");
      }
      const canonicalAsset = toExternalAssetV2(verifiedAsset);
      const wasConversionPlaceholder =
        asset.mimeType === "application/octet-stream" && asset.created === 0;
      if (
        !wasConversionPlaceholder &&
        asset.mimeType !== canonicalAsset.mimeType
      ) {
        throw new Error("ASSET_METADATA_MISMATCH");
      }
      return [id, wasConversionPlaceholder ? canonicalAsset : asset] as const;
    }),
  );
  return createWhiteboardDocumentV2({
    ...document,
    assets: Object.fromEntries(entries),
  });
}

async function readExternalAsset(
  record: WhiteboardConvergenceFileRecord,
  fetchAsset: FetchAsset,
): Promise<WhiteboardAsset> {
  const response = await fetchAsset(record.url);
  if (!response.ok) throw new Error("ASSET_FETCH_FAILED");
  const compressed = new Uint8Array(await response.arrayBuffer());
  if (
    record.contentHash &&
    hashBytes(compressed) !== record.contentHash.toLowerCase()
  ) {
    throw new Error("ASSET_CONTENT_HASH_MISMATCH");
  }
  const { metadata, data } = await decompressData<FileMetadata>(compressed, {
    decryptionKey: "",
    maxDecompressedBytes: MAX_DECOMPRESSED_ASSET_BYTES,
  });
  const dataURL = new TextDecoder().decode(data);
  if (
    typeof metadata.id !== "string" ||
    metadata.id.length === 0 ||
    typeof metadata.mimeType !== "string" ||
    typeof metadata.created !== "number" ||
    !Number.isFinite(metadata.created) ||
    !dataURL.startsWith("data:")
  ) {
    throw new Error("INVALID_ASSET_CONTENT");
  }
  return {
    id: metadata.id,
    mimeType: metadata.mimeType,
    created: metadata.created,
    dataURL,
    ...(typeof metadata.lastRetrieved === "number" &&
    Number.isFinite(metadata.lastRetrieved)
      ? { lastRetrieved: metadata.lastRetrieved }
      : {}),
  };
}

function toExternalAssetV2(asset: WhiteboardAsset): WhiteboardAssetV2 {
  const validationDocument = createPersistedWhiteboardDocumentV2(
    {
      elements: [
        {
          id: "asset-validation",
          type: "image",
          isDeleted: false,
          fileId: asset.id,
        },
      ],
      assets: { [asset.id]: asset },
      state: {},
    },
    { assetStorage: "external" },
  );
  return validationDocument.assets[asset.id]!;
}

async function decodeSceneData(sceneData: string): Promise<string> {
  const compressed = new Uint8Array(base64ToArrayBuffer(sceneData));
  const { data } = await decompressData<Record<string, never>>(compressed, {
    decryptionKey: "",
    maxDecompressedBytes: MAX_DECOMPRESSED_SCENE_BYTES,
  });
  return new TextDecoder().decode(data);
}

function collectReferencedAssetIds(
  document: WhiteboardDocumentV2,
): readonly string[] {
  return [
    ...new Set(
      document.elements.flatMap((element) =>
        !element.isDeleted &&
        element.type === "image" &&
        typeof element.fileId === "string"
          ? [element.fileId]
          : [],
      ),
    ),
  ].sort();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function classifyConvergenceError(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN";
  if (error instanceof WhiteboardDocumentError) return error.code;
  const code = error.message.split(":")[0] ?? "";
  return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : error.name;
}
