import "server-only";

import { parseDrawstuffDocument } from "@drawstuff/excalidraw-adapter/codec";

import { decompressData } from "@/lib/encode";

/**
 * Which assets a stored scene document still references.
 *
 * This is the retention authority for owned-scene assets: an asset is needed
 * exactly when a live image element in the committed document points at its
 * Excalidraw file id. Both callers need that answer for opposite reasons — the
 * published page must not expose an asset the scene no longer shows, and asset
 * cleanup must not delete one it still does.
 */

type StoredSceneElement = {
  isDeleted?: boolean;
  type?: string;
  fileId?: unknown;
};

/**
 * Returns the referenced file ids, or `null` when the document cannot be read.
 *
 * `null` is deliberately not an empty set: "this scene references nothing" and
 * "we could not find out" must lead to opposite decisions at both call sites, so
 * they cannot share a representation.
 */
export async function readReferencedSceneAssetIds(
  sceneData: string | null | undefined,
): Promise<Set<string> | null> {
  if (!sceneData) return new Set();
  try {
    const compressed = new Uint8Array(Buffer.from(sceneData, "base64"));
    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
    });
    const parsed = parseDrawstuffDocument(new TextDecoder().decode(data));
    const ids = new Set<string>();
    for (const element of parsed.scene
      .elements as readonly StoredSceneElement[]) {
      if (element.isDeleted) continue;
      if (element.type !== "image") continue;
      if (typeof element.fileId === "string" && element.fileId.length > 0) {
        ids.add(element.fileId);
      }
    }
    return ids;
  } catch (error) {
    console.error("Failed to parse scene asset references:", error);
    return null;
  }
}

export type SceneAssetCleanupPlan = {
  /** Keys safe to delete: no record points at them, or the scene dropped them. */
  deletableKeys: string[];
  /** Keys kept because the committed document still needs their asset. */
  retainedKeys: string[];
};

/**
 * Decides which of an aborted save's uploads may actually be removed.
 *
 * The caller is a save that failed, so its instinct is to delete everything it
 * uploaded — but its upload may have become the *only* stored copy of an asset
 * that a different save then committed. Two concurrent saves introducing the
 * same new image is exactly that case: one insert wins and one is refused as a
 * retry, so the winner's row is the single record for those bytes even if the
 * request that created it is the one that later failed.
 *
 * So the committed document decides, not the failing request:
 *
 * - A key with no record is always deletable — nothing can resolve it.
 * - A key whose record's file id is still referenced is retained.
 * - When the document cannot be read, every record is retained: keeping an
 *   orphaned object costs storage, deleting a referenced one loses a user's
 *   image.
 */
export function planSceneAssetCleanup(params: {
  requestedKeys: readonly string[];
  records: ReadonlyArray<{ utFileKey: string; excalidrawFileId: string }>;
  referencedFileIds: Set<string> | null;
}): SceneAssetCleanupPlan {
  const fileIdByKey = new Map(
    params.records.map((record) => [record.utFileKey, record.excalidrawFileId]),
  );
  const deletableKeys: string[] = [];
  const retainedKeys: string[] = [];

  for (const key of new Set(params.requestedKeys)) {
    const fileId = fileIdByKey.get(key);
    if (fileId === undefined) {
      deletableKeys.push(key);
      continue;
    }
    if (params.referencedFileIds === null) {
      retainedKeys.push(key);
      continue;
    }
    if (params.referencedFileIds.has(fileId)) retainedKeys.push(key);
    else deletableKeys.push(key);
  }

  return { deletableKeys, retainedKeys };
}
