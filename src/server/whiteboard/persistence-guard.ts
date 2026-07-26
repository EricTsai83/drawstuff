import "server-only";

import {
  classifyWhiteboardWriteTransition,
  detectWhiteboardDocumentFormat,
} from "@/features/whiteboard";
import {
  base64ToArrayBuffer,
  DecompressionLimitError,
  decompressData,
} from "@/lib/encode";
import { SCENE_DATA_MAX_LENGTH } from "@/lib/schemas/scene";

export const MAX_DECOMPRESSED_SCENE_BYTES = SCENE_DATA_MAX_LENGTH * 32;

export async function validateStoredWhiteboardWrite(
  currentData: string | null,
  nextData: string,
): Promise<"safe" | "unsafe-downgrade" | "too-large" | "invalid"> {
  try {
    const nextPayload = await decodeScenePayload(nextData);
    if (currentData === null) return "safe";
    if (detectWhiteboardDocumentFormat(nextPayload) === "whiteboard-v1") {
      return "safe";
    }
    const currentPayload = await decodeScenePayload(currentData);
    return classifyWhiteboardWriteTransition(currentPayload, nextPayload);
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
