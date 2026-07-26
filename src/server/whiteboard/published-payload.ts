import "server-only";

import {
  createPersistedWhiteboardDocumentV1,
  parsePersistedWhiteboardPayload,
  serializeWhiteboardDocumentV1,
  toRuntimeWhiteboardDocument,
} from "@/features/whiteboard";
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
    const persisted = parsePersistedWhiteboardPayload(
      new TextDecoder().decode(data),
      { allowMissingAssets: true },
    );
    if (persisted.format === "legacy-excalidraw") {
      return sceneData;
    }

    const publicDocument = createPersistedWhiteboardDocumentV1(
      toRuntimeWhiteboardDocument(persisted.document),
      {
        includeInlineAssets: false,
        retainLegacy: false,
      },
    );
    const publicCompressed = await compressData(
      new TextEncoder().encode(
        serializeWhiteboardDocumentV1(publicDocument, {
          allowMissingAssets: true,
        }),
      ),
      {},
    );
    return Buffer.from(publicCompressed).toString("base64");
  } catch (error) {
    console.error("Failed to create public whiteboard payload:", error);
    return null;
  }
}
