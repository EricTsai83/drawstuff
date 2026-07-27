import { base64ToArrayBuffer, decompressData } from "@/lib/encode";
import {
  parseWhiteboardDocumentV3,
  toRuntimeWhiteboardDocumentV3,
  type WhiteboardAsset,
  type OwnedWhiteboardDocument,
} from "@drawstuff/whiteboard";
import { resolveWhiteboardAssets } from "@drawstuff/whiteboard";

type DecompressedFileMetadata = {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved?: number;
};

export async function loadPublishedSceneData({
  sceneData,
  fileRecords,
  signal,
}: {
  sceneData: string;
  fileRecords: Array<{ url: string }>;
  signal?: AbortSignal;
}): Promise<OwnedWhiteboardDocument> {
  const compressedBuffer = new Uint8Array(base64ToArrayBuffer(sceneData));
  const { data } = await decompressData<Record<string, never>>(
    compressedBuffer,
    { decryptionKey: "" },
  );
  const parsed = toRuntimeWhiteboardDocumentV3(
    parseWhiteboardDocumentV3(new TextDecoder().decode(data)),
  );

  const publishedAssets: Record<string, WhiteboardAsset> = {};
  await Promise.allSettled(
    fileRecords.map(async ({ url }) => {
      const response = await fetch(url, { signal });
      if (!response.ok) return;
      const fileBuffer = new Uint8Array(await response.arrayBuffer());
      const { metadata, data: fileData } =
        await decompressData<DecompressedFileMetadata>(fileBuffer, {
          decryptionKey: "",
        });
      const asset = publishedAssetFromPayload(
        metadata,
        new TextDecoder().decode(fileData),
      );
      if (asset) publishedAssets[asset.id] = asset;
    }),
  );
  if (signal?.aborted) {
    throw new DOMException(
      "The published scene request was aborted",
      "AbortError",
    );
  }

  return {
    elements: parsed.elements,
    state: {
      ...parsed.state,
      scrollX: undefined,
      scrollY: undefined,
      zoom: undefined,
      viewModeEnabled: true,
      zenModeEnabled: true,
    },
    assets: resolveWhiteboardAssets(
      parsed.elements,
      publishedAssets,
      parsed.assets,
    ),
  };
}

function publishedAssetFromPayload(
  metadata: DecompressedFileMetadata,
  dataURL: string,
): WhiteboardAsset | null {
  if (
    typeof metadata.id !== "string" ||
    metadata.id.length === 0 ||
    typeof metadata.mimeType !== "string" ||
    typeof metadata.created !== "number" ||
    !Number.isFinite(metadata.created)
  ) {
    return null;
  }
  const asset: WhiteboardAsset = {
    id: metadata.id,
    dataURL,
    mimeType: metadata.mimeType,
    created: metadata.created,
    ...(typeof metadata.lastRetrieved === "number" &&
    Number.isFinite(metadata.lastRetrieved)
      ? { lastRetrieved: metadata.lastRetrieved }
      : {}),
  };
  return asset;
}
