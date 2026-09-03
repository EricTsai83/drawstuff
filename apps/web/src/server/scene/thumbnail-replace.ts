import "server-only";

import { db } from "@/server/db";
import { QUERIES } from "@/server/db/queries";
import { enqueueStorageKeyCleanup } from "@/server/storage/reclaim";

/**
 * Applies a completed thumbnail upload with compare-and-set semantics: the
 * update lands only while the scene still holds the key this call read (or
 * none), so two interleaved uploads leave exactly one referenced key instead
 * of orphaning one forever — thumbnails have no GC sweep to fall back on.
 *
 * The losing key — the previous thumbnail on success, the fresh upload when
 * the CAS misses (a concurrent replacement won, or the scene is gone) — is
 * handed to `deleteObject`; when that reports failure the key goes to the
 * durable cleanup queue.
 */
export async function replaceSceneThumbnail(params: {
  sceneId: string;
  fileKey: string;
  fileUrl: string;
  /** Attempts the storage delete; `false` routes the key to the queue. */
  deleteObject: (key: string) => Promise<boolean>;
}): Promise<{ applied: boolean }> {
  const oldKey = (await QUERIES.getSceneThumbnailKey(params.sceneId)) ?? null;
  const updated = await QUERIES.updateSceneThumbnail(params.sceneId, {
    thumbnailUrl: params.fileUrl,
    thumbnailFileKey: params.fileKey,
    expectedThumbnailFileKey: oldKey,
  });
  const applied = updated.length > 0;
  const loserKey = applied
    ? oldKey !== params.fileKey
      ? oldKey
      : null
    : params.fileKey;
  if (loserKey) {
    const deleted = await params.deleteObject(loserKey);
    if (!deleted) {
      try {
        await enqueueStorageKeyCleanup(db, [loserKey], "replace-thumbnail", {
          sceneId: params.sceneId,
        });
      } catch (error) {
        // 排queue失敗只會多一個孤兒物件；不能讓它使已 commit 的替換整個失敗。
        console.error("Failed to enqueue deferred cleanup", {
          fileKey: loserKey,
          sceneId: params.sceneId,
          error,
        });
      }
    }
  }
  return { applied };
}
