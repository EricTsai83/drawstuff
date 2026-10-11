import "server-only";

import { and, eq } from "drizzle-orm";

import type { Database } from "@/server/collab/rooms";
import { scene } from "@/server/db/schema";
import {
  CLEARED_PUBLISHED_ARTIFACT_COLUMNS,
  readPublishedArtifacts,
} from "@/server/scene/published-artifacts";
import { enqueueStorageKeyCleanup } from "@/server/storage/reclaim";

/**
 * Takes a scene off its public page: clears the published columns and queues
 * both render artifacts for deletion in one transaction. `ownerUserId` scopes
 * it to the owner; the admin console omits it. Null when no such scene.
 */
export async function unpublishScene(
  db: Database,
  sceneId: string,
  ownerUserId?: string,
): Promise<{ id: string } | null> {
  const now = new Date();
  return await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: scene.id })
      .from(scene)
      .where(
        ownerUserId
          ? and(eq(scene.id, sceneId), eq(scene.userId, ownerUserId))
          : eq(scene.id, sceneId),
      )
      .for("update");
    if (!target) return null;
    // 成品只服務公開頁：撤回公開時清指標並把兩個物件排進 outbox。
    const artifacts = await readPublishedArtifacts(tx, sceneId);
    await tx
      .update(scene)
      .set({
        isPublished: false,
        publishedSlug: null,
        publishedAt: null,
        updatedAt: now,
        ...CLEARED_PUBLISHED_ARTIFACT_COLUMNS,
      })
      .where(eq(scene.id, sceneId));
    await enqueueStorageKeyCleanup(
      tx,
      artifacts?.keys ?? [],
      "unpublish-scene",
      { sceneId },
    );
    return { id: target.id };
  });
}
