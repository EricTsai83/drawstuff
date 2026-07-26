import { restore } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import { base64ToArrayBuffer, decompressData } from "@/lib/encode";
import { ensureInitialAppState } from "@/lib/excalidraw";

type StoredScenePayload = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState>;
};

type DecompressedFileMetadata = {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved: number;
};

export async function loadPublishedSceneData({
  sceneData,
  fileRecords,
  signal,
}: {
  sceneData: string;
  fileRecords: Array<{ url: string }>;
  signal?: AbortSignal;
}): Promise<ExcalidrawInitialDataState> {
  const compressedBuffer = new Uint8Array(base64ToArrayBuffer(sceneData));
  const { data } = await decompressData<Record<string, never>>(
    compressedBuffer,
    { decryptionKey: "" },
  );
  const parsed = JSON.parse(
    new TextDecoder().decode(data),
  ) as StoredScenePayload;

  const files: BinaryFiles = {};
  await Promise.allSettled(
    fileRecords.map(async ({ url }) => {
      const response = await fetch(url, { signal });
      if (!response.ok) return;

      const fileBuffer = new Uint8Array(await response.arrayBuffer());
      const { metadata, data: fileData } =
        await decompressData<DecompressedFileMetadata>(fileBuffer, {
          decryptionKey: "",
        });

      const id = metadata.id as FileId;
      files[id] = {
        id,
        dataURL: new TextDecoder().decode(fileData) as DataURL,
        mimeType: metadata.mimeType as BinaryFileData["mimeType"],
        created: metadata.created,
        lastRetrieved: metadata.lastRetrieved,
      };
    }),
  );

  const restored = restore(
    {
      elements: parsed.elements ?? null,
      appState: parsed.appState ?? null,
      files,
    },
    null,
    null,
    { repairBindings: true, refreshDimensions: false },
  );

  return {
    elements: restored.elements ?? [],
    appState: {
      ...ensureInitialAppState(restored.appState ?? {}),
      scrollX: undefined,
      scrollY: undefined,
      zoom: undefined,
      viewModeEnabled: true,
      zenModeEnabled: true,
    },
    files: restored.files ?? files,
  };
}
