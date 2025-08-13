import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import { decompressData, base64ToArrayBuffer } from "./encode";
import { createTRPCProxyClient, httpBatchStreamLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { AppRouter } from "@/server/api/root";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import { getBaseUrl } from "@/lib/base-url";

export async function importDataFromBackend(
  id: string,
  decryptionKey: string,
): Promise<ImportedDataState> {
  try {
    const client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchStreamLink({
          transformer: SuperJSON,
          url: getBaseUrl() + "/api/trpc",
          headers() {
            const headers = new Headers();
            headers.set("x-trpc-source", "importDataFromBackend");
            return headers;
          },
        }),
      ],
    });

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
  // 僅保留可序列化且安全的欄位，避免像 collaborators 這類需要特殊型別的欄位破壞型態
  const { theme, viewBackgroundColor, gridSize, name } = appState;
  return { theme, viewBackgroundColor, gridSize, name };
}
