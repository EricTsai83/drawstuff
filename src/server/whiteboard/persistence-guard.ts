import "server-only";

import {
  parseWhiteboardDocumentV2,
  WHITEBOARD_DOCUMENT_VERSION,
} from "@drawstuff/whiteboard";
import {
  base64ToArrayBuffer,
  DecompressionLimitError,
  decompressData,
} from "@/lib/encode";
import { SCENE_DATA_MAX_LENGTH } from "@/lib/schemas/scene";

export const MAX_DECOMPRESSED_SCENE_BYTES = SCENE_DATA_MAX_LENGTH * 32;

export function validateOpaqueEncryptedWhiteboardWrite(
  encodedData: string,
  documentVersion: unknown,
): "safe" | "stale-version" | "too-large" {
  if (documentVersion !== WHITEBOARD_DOCUMENT_VERSION) {
    return "stale-version";
  }
  return encodedData.length > SCENE_DATA_MAX_LENGTH ? "too-large" : "safe";
}

export async function validateStoredWhiteboardWrite(
  nextData: string,
  documentVersion: unknown,
): Promise<"safe" | "stale-version" | "too-large" | "invalid"> {
  if (documentVersion !== WHITEBOARD_DOCUMENT_VERSION) {
    return "stale-version";
  }
  try {
    const nextPayload = await decodeScenePayload(nextData);
    parseWhiteboardDocumentV2(nextPayload);
    return "safe";
  } catch (error) {
    return error instanceof DecompressionLimitError ? "too-large" : "invalid";
  }
}

async function decodeScenePayload(data: string): Promise<string> {
  const compressed = new Uint8Array(base64ToArrayBuffer(data));
  const { data: decoded } = await decompressData<Record<string, never>>(
    compressed,
    {
      decryptionKey: "",
      maxDecompressedBytes: MAX_DECOMPRESSED_SCENE_BYTES,
    },
  );
  return new TextDecoder().decode(decoded);
}
