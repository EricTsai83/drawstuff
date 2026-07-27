import "server-only";

import {
  externalizeWhiteboardDocumentAssetsV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
} from "@drawstuff/whiteboard";
import { compressData, decompressData } from "@/lib/encode";
import { MAX_DECOMPRESSED_SCENE_BYTES } from "./persistence-guard";

export async function createPublicWhiteboardPayload(
  sceneData: string,
): Promise<string | null> {
  try {
    const compressed = new Uint8Array(Buffer.from(sceneData, "base64"));
    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
      maxDecompressedBytes: MAX_DECOMPRESSED_SCENE_BYTES,
    });
    const source = new TextDecoder().decode(data);
    const document = parseWhiteboardDocumentV2(source);
    const publicDocument = externalizeWhiteboardDocumentAssetsV2(document);
    const publicCompressed = await compressData(
      new TextEncoder().encode(serializeWhiteboardDocumentV2(publicDocument)),
      {},
    );
    return Buffer.from(publicCompressed).toString("base64");
  } catch (error) {
    console.error("Failed to create public whiteboard payload:", error);
    return null;
  }
}
