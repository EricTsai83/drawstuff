import type { ImportedDataState } from "@drawstuff/excalidraw-adapter/types";
import { decompressData, base64ToArrayBuffer } from "./encode";
import { getTrpcClient } from "@/trpc/client";
import type { FileId } from "@drawstuff/excalidraw-adapter/types";
import type {
  BinaryFiles,
  BinaryFileData,
  DataURL,
} from "@drawstuff/excalidraw-adapter/types";
import { decodePersistedScene } from "./persisted-scene";

export async function importDataFromBackend(
  id: string,
  decryptionKey: string,
): Promise<ImportedDataState> {
  try {
    const client = getTrpcClient();

    const result = await client.sharedScene.getCompressedBySharedSceneId.query({
      sharedSceneId: id,
    });

    const compressed = result?.compressedData;
    if (!compressed) {
      return {};
    }

    const compressedBuffer = toUint8Array(compressed);

    const { data: decodedBuffer } = await decompressData(
      new Uint8Array(compressedBuffer),
      { decryptionKey },
    );

    const parsed = decodePersistedScene(decodedBuffer);

    return {
      elements: parsed.elements,
      appState: parsed.appState,
    };
  } catch (error: unknown) {
    console.error("importFromBackend error", error);
    console.error(error);
    return {};
  }
}

type CloudFileRecord = {
  /** 只有 owner-only 的 scene 端點回傳；公開的 shared-scene 端點不洩漏。 */
  utFileKey?: string;
  url: string;
  /** Immutable Excalidraw file id; the identity the element's `fileId` matches. */
  excalidrawFileId: string;
  size: number;
};

type SceneFileMetadata = {
  id: FileId;
  mimeType: BinaryFileData["mimeType"];
  created: number;
  lastRetrieved: number;
};

export type ImportedSceneData = ImportedDataState & {
  revision?: number;
  updatedAt?: string;
  workspaceId?: string;
};

async function getFileRecordsBySharedSceneId(
  sharedSceneId: string,
): Promise<CloudFileRecord[]> {
  try {
    const client = getTrpcClient();

    const res = await client.sharedScene.getFileRecordsBySharedSceneId.query({
      sharedSceneId,
    });

    return Array.isArray(res?.files) ? res.files : [];
  } catch (error: unknown) {
    console.error("getFileRecordsBySharedSceneId error", error);
    return [];
  }
}

async function getFileRecordsBySceneId(
  sceneId: string,
): Promise<CloudFileRecord[]> {
  try {
    const client = getTrpcClient();

    const res = await client.scene.getFileRecordsBySceneId.query({
      id: sceneId,
    });

    return Array.isArray(res?.files) ? res.files : [];
  } catch (error: unknown) {
    console.error("getFileRecordsBySceneId error", error);
    return [];
  }
}

async function importSceneFilesFromRecords(
  records: CloudFileRecord[],
  decryptionKey: string,
): Promise<BinaryFiles> {
  if (records.length === 0) {
    return {};
  }

  const decoder = new TextDecoder();
  const entries = await Promise.allSettled(
    records.map(async (record) => {
      const response = await fetch(record.url);
      if (!response.ok) {
        return null;
      }

      const compressed = new Uint8Array(await response.arrayBuffer());
      const { metadata, data } = await decompressData<SceneFileMetadata>(
        compressed,
        {
          decryptionKey,
        },
      );
      const dataURL = decoder.decode(data);
      if (!dataURL.startsWith("data:")) {
        return null;
      }

      // The record is the identity of an asset; the id inside the payload is a
      // copy of it. They can only disagree if the wrong object was stored under
      // this record, and injecting such a file would render one image where
      // another belongs — so refuse it instead of trusting either side.
      if (metadata.id !== record.excalidrawFileId) {
        console.error("Asset payload does not match its record identity", {
          recordFileId: record.excalidrawFileId,
          payloadFileId: metadata.id,
        });
        return null;
      }

      const file: BinaryFileData = {
        id: metadata.id,
        dataURL: dataURL as DataURL,
        mimeType: metadata.mimeType,
        created: metadata.created,
        lastRetrieved: metadata.lastRetrieved,
      };

      return [metadata.id, file] as const;
    }),
  );

  const files: BinaryFiles = {};
  for (const entry of entries) {
    if (entry.status !== "fulfilled" || !entry.value) continue;
    const [fileId, file] = entry.value;
    files[fileId] = file;
  }

  return files;
}

export async function importSceneFilesBySceneId(
  sceneId: string,
): Promise<BinaryFiles> {
  try {
    const records = await getFileRecordsBySceneId(sceneId);
    return importSceneFilesFromRecords(records, "");
  } catch (error: unknown) {
    console.error("importSceneFilesBySceneId error", error);
    return {};
  }
}

export async function importSharedSceneFilesBySharedSceneId(
  sharedSceneId: string,
  decryptionKey: string,
): Promise<BinaryFiles> {
  try {
    const records = await getFileRecordsBySharedSceneId(sharedSceneId);
    return importSceneFilesFromRecords(records, decryptionKey);
  } catch (error: unknown) {
    console.error("importSharedSceneFilesBySharedSceneId error", error);
    return {};
  }
}

function toUint8Array(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return new Uint8Array(input as number[]);
  if (typeof input === "object" && input !== null) {
    const maybe = input as { type?: string; data?: unknown };
    if (maybe.type === "Buffer" && Array.isArray(maybe.data)) {
      return new Uint8Array(maybe.data as number[]);
    }
  }
  if (typeof input === "string") {
    return new Uint8Array(base64ToArrayBuffer(input));
  }
  throw new Error("Unsupported compressed data format");
}

// 非分享模式：直接以 sceneId 讀取壓縮過的 sceneData，解壓並回傳
export async function importSceneDataBySceneId(
  sceneId: string,
): Promise<ImportedSceneData> {
  try {
    const client = getTrpcClient();
    const result = await client.scene.getScene.query({ id: sceneId });
    const compressed = result?.sceneData;
    if (!compressed) {
      return {
        revision: normalizeRevision(result?.revision),
        updatedAt: normalizeUpdatedAt(result?.updatedAt),
        workspaceId: result?.workspaceId ?? undefined,
      };
    }
    const compressedBuffer = new Uint8Array(base64ToArrayBuffer(compressed));
    const { data } = await decompressData<{ id?: string }>(compressedBuffer, {
      // 未加密情況下，此值不會被使用
      decryptionKey: "",
    });
    const parsed = decodePersistedScene(data);
    const sanitizedAppState = parsed.appState;
    // DB name 欄位是權威來源（rename 只更新 DB name，不重寫 sceneData），
    // 用它覆蓋壓縮資料中可能過時的 appState.name
    if (sanitizedAppState && result?.name) {
      sanitizedAppState.name = result.name;
    }
    return {
      elements: parsed.elements,
      appState: sanitizedAppState,
      revision: normalizeRevision(result?.revision),
      updatedAt: normalizeUpdatedAt(result?.updatedAt),
      workspaceId: result?.workspaceId ?? undefined,
    };
  } catch (error: unknown) {
    console.error("importSceneDataBySceneId error", error);
    return {};
  }
}

export async function getSceneMetaBySceneId(
  sceneId: string,
): Promise<{ id: string; revision?: number; updatedAt?: string } | null> {
  try {
    const client = getTrpcClient();
    const result = await client.scene.getSceneMeta.query({ id: sceneId });
    if (!result?.id) {
      return null;
    }
    return {
      id: result.id,
      revision: normalizeRevision(result.revision),
      updatedAt: normalizeUpdatedAt(result.updatedAt),
    };
  } catch (error: unknown) {
    console.error("getSceneMetaBySceneId error", error);
    return null;
  }
}

function normalizeUpdatedAt(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function normalizeRevision(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
