import "server-only";

import {
  DRAWSTUFF_DOCUMENT_VERSION,
  parseDrawstuffDocument,
} from "@drawstuff/excalidraw-adapter/codec";
import {
  base64ToArrayBuffer,
  DecompressionLimitError,
  decompressData,
} from "@/lib/encode";
import { SCENE_DATA_MAX_LENGTH } from "@/lib/schemas/scene";

const MAX_DECOMPRESSED_SCENE_BYTES = SCENE_DATA_MAX_LENGTH * 32;

export function validateOpaqueV4Write(
  data: Uint8Array,
  documentVersion: unknown,
): "safe" | "stale-version" | "too-large" {
  if (documentVersion !== DRAWSTUFF_DOCUMENT_VERSION) {
    return "stale-version";
  }
  return data.byteLength > SCENE_DATA_MAX_LENGTH ? "too-large" : "safe";
}

export async function validateStoredV4Write(
  encodedData: string,
): Promise<"safe" | "too-large" | "invalid" | "stale-version"> {
  if (encodedData.length > SCENE_DATA_MAX_LENGTH) return "too-large";
  try {
    const compressed = new Uint8Array(base64ToArrayBuffer(encodedData));
    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
      maxDecompressedBytes: MAX_DECOMPRESSED_SCENE_BYTES,
    });
    if (!data) return "invalid";
    const payload = JSON.parse(new TextDecoder().decode(data)) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("version" in payload) ||
      payload.version !== DRAWSTUFF_DOCUMENT_VERSION
    ) {
      return "stale-version";
    }
    return parseDrawstuffDocument(payload).ok ? "safe" : "invalid";
  } catch (error) {
    return error instanceof DecompressionLimitError ? "too-large" : "invalid";
  }
}
