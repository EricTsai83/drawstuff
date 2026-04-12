import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import { decompressData, base64ToArrayBuffer } from "./encode";
import { getTrpcClient } from "@/trpc/client";
import type {
  ExcalidrawElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";
import { ensureInitialAppState } from "@/lib/excalidraw";

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

    const parsed = JSON.parse(new TextDecoder().decode(decodedBuffer)) as {
      elements?: ExcalidrawElement[];
      appState?: Partial<AppState>;
    };

    const sanitizedAppState = parsed.appState
      ? sanitizeImportedAppState(parsed.appState)
      : null;

    return {
      elements: parsed.elements ?? null,
      appState: sanitizedAppState,
    };
  } catch (error: unknown) {
    console.error("importFromBackend error", error);
    console.error(error);
    return {};
  }
}

export type CloudFileRecord = {
  utFileKey: string;
  url: string;
  name: string;
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
};

export async function getFileRecordsBySharedSceneId(
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

export async function getFileRecordsBySceneId(
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

export async function importSceneFilesBySceneId(
  sceneId: string,
): Promise<BinaryFiles> {
  try {
    const records = await getFileRecordsBySceneId(sceneId);
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
            decryptionKey: "",
          },
        );
        const dataURL = decoder.decode(data);
        if (!dataURL.startsWith("data:")) {
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
  } catch (error: unknown) {
    console.error("importSceneFilesBySceneId error", error);
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

function sanitizeImportedAppState(
  appState: Partial<AppState>,
): Partial<AppState> {
  return ensureInitialAppState(appState);
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
      };
    }
    const compressedBuffer = new Uint8Array(base64ToArrayBuffer(compressed));
    const { data } = await decompressData<{ id?: string }>(compressedBuffer, {
      // 未加密情況下，此值不會被使用
      decryptionKey: "",
    });
    const parsed = JSON.parse(new TextDecoder().decode(data)) as {
      elements?: ExcalidrawElement[];
      appState?: Partial<AppState>;
    };
    const sanitizedAppState = parsed.appState
      ? sanitizeImportedAppState(parsed.appState)
      : null;
    return {
      elements: parsed.elements ?? null,
      appState: sanitizedAppState,
      revision: normalizeRevision(result?.revision),
      updatedAt: normalizeUpdatedAt(result?.updatedAt),
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
