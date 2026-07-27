import type { WhiteboardDocumentV3 } from "./contracts";
import {
  parseWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
} from "./canonical-document";
import {
  createPersistedWhiteboardDocumentV3,
  createWhiteboardDocumentV3,
} from "./v3-document";

export {
  createPersistedWhiteboardDocumentV2,
  createWhiteboardDocumentV2,
  externalizeWhiteboardDocumentAssetsV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
} from "./canonical-document";
export type {
  WhiteboardAssetV2,
  WhiteboardDocumentV2,
  WhiteboardElementV2,
} from "./contracts";

/**
 * Server-only deterministic migration. Keep this subpath out of client imports.
 */
export function migrateWhiteboardDocumentV2(
  input: unknown,
): WhiteboardDocumentV3 {
  const source = parseWhiteboardDocumentV2(input);
  const runtime = toRuntimeWhiteboardDocumentV2(source);
  const migrated = createPersistedWhiteboardDocumentV3(
    {
      ...runtime,
      assets: Object.fromEntries(
        Object.entries(source.assets).map(([id, asset]) => [
          id,
          {
            id,
            dataURL:
              asset.storage === "inline"
                ? asset.dataURL
                : `data:${asset.mimeType};base64,`,
            mimeType: asset.mimeType,
            created: asset.created,
            lastRetrieved: asset.lastRetrieved,
            byteSize: asset.byteSize,
            contentHash: asset.contentHash,
            width: asset.width,
            height: asset.height,
          },
        ]),
      ),
    },
    { now: 0 },
  );
  return createWhiteboardDocumentV3({
    ...migrated,
    assets: Object.fromEntries(
      Object.entries(source.assets).map(([id, asset]) => [
        id,
        {
          ...asset,
          revision: 1,
        },
      ]),
    ),
  });
}
