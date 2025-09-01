import { NextResponse } from "next/server";
import { QUERIES } from "@/server/db/queries";
import { UTApi } from "uploadthing/server";

// 基本的清理處理器：由外部 Cron 觸發
export async function POST(request: Request) {
  // 授權：僅接受 Authorization: Bearer <CRON_SECRET>
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const utapi = new UTApi();

  try {
    // 1) 針對「非擁有者」先清 UploadThing 檔案，然後再刪除使用者（cascade 刪 DB）
    const ownerEmail = process.env.CLEANUP_OWNER_EMAIL;
    let deletedUsers = 0;
    if (ownerEmail) {
      // 收集非擁有者 userIds、其 scenes、以及所有相關檔案 keys
      const userIds = await QUERIES.getUserIdsExceptEmail(ownerEmail);
      const sceneIds = await QUERIES.getSceneIdsByUserIds(userIds);
      const fileKeysByOwner = await QUERIES.getFileKeysByOwnerIds(userIds);
      const fileKeysByScene = await QUERIES.getFileKeysBySceneIds(sceneIds);
      const thumbKeys = await QUERIES.getSceneThumbnailKeysByUserIds(userIds);
      const allKeys = Array.from(
        new Set<string>([...fileKeysByOwner, ...fileKeysByScene, ...thumbKeys]),
      );
      // 刪遠端檔案（失敗則入佇列）
      for (const key of allKeys) {
        try {
          await utapi.deleteFiles([key]);
        } catch {
          await QUERIES.enqueueDeferredCleanup({
            utFileKey: key,
            reason: "delete-user",
            context: { ownerEmail },
          });
        }
      }
      // 再刪除使用者（cascade 刪其 DB 資料）
      const rows = await QUERIES.deleteUsersExceptEmail(ownerEmail);
      deletedUsers = rows.length;
    }

    // 2) 刪除一個月前的 sharedScene 與其檔案（亦會觸發 deferred 清理機制）
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldIds = await QUERIES.getSharedSceneIdsOlderThan(cutoff);
    type OldFile = { utFileKey: string; sharedSceneId: string | null };
    const oldFiles = (await QUERIES.getFileRecordsBySharedSceneIds(
      oldIds,
    )) as OldFile[];
    // 先嘗試刪除遠端檔案（不阻斷 DB 刪除）
    let deletedRemote = 0;
    for (const f of oldFiles) {
      try {
        await utapi.deleteFiles([f.utFileKey]);
        deletedRemote += 1;
      } catch {
        await QUERIES.enqueueDeferredCleanup({
          utFileKey: f.utFileKey,
          reason: "sharedScene_expired",
          context: { sharedSceneId: f.sharedSceneId },
        });
      }
    }
    let deletedSharedCount: number;
    {
      const deletedShared = await QUERIES.deleteSharedScenesOlderThan(cutoff);
      deletedSharedCount = Array.isArray(deletedShared)
        ? deletedShared.length
        : 0;
    }

    // 3) 刪除無場景使用的孤兒分類（批次）
    const orphanIds = await QUERIES.getOrphanCategoryIds(1000);
    let deletedCategoriesCount: number;
    {
      const deletedCategories = await QUERIES.deleteCategoriesByIds(orphanIds);
      deletedCategoriesCount = Array.isArray(deletedCategories)
        ? deletedCategories.length
        : 0;
    }

    type DeferredCleanupTask = {
      id: string;
      utFileKey: string;
      attempts: number | null;
    };
    const tasks = (await QUERIES.getDueDeferredCleanups(
      50,
    )) as DeferredCleanupTask[];
    // 4) 刪除過期 sessions（含你的，因為與 user 無關）
    let deletedExpiredSessionsCount: number;
    {
      const deletedExpiredSessions = await QUERIES.deleteExpiredSessions(
        new Date(),
      );
      deletedExpiredSessionsCount = Array.isArray(deletedExpiredSessions)
        ? deletedExpiredSessions.length
        : 0;
    }
    // 5) 刪除已過期的 verification 記錄
    let deletedExpiredVerificationsCount: number;
    {
      const deletedExpiredVerifications =
        await QUERIES.deleteExpiredVerifications(new Date());
      deletedExpiredVerificationsCount = Array.isArray(
        deletedExpiredVerifications,
      )
        ? deletedExpiredVerifications.length
        : 0;
    }
    // 6) 清理已完成/失敗且超過 30 天的延遲清理任務
    const cleanupCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let purgedDeferredCleanupsCount: number;
    {
      const purgedDeferredCleanups =
        await QUERIES.purgeDeferredFileCleanupOlderThan(cleanupCutoff, [
          "done",
          "failed",
        ]);
      purgedDeferredCleanupsCount = Array.isArray(purgedDeferredCleanups)
        ? purgedDeferredCleanups.length
        : 0;
    }
    if (tasks.length === 0) {
      return NextResponse.json({
        processed: 0,
        deletedUsers,
        deletedExpiredSharedScenes: deletedSharedCount,
        deletedRemoteFiles: deletedRemote,
        deletedOrphanCategories: deletedCategoriesCount,
        deletedExpiredSessions: deletedExpiredSessionsCount,
        deletedExpiredVerifications: deletedExpiredVerificationsCount,
        purgedDeferredCleanups: purgedDeferredCleanupsCount,
      });
    }

    let processed = 0;
    for (const task of tasks) {
      try {
        await utapi.deleteFiles([task.utFileKey]);
        await QUERIES.markDeferredCleanupDone(task.id);
        processed += 1;
      } catch (err: unknown) {
        const attempts = task.attempts ?? 0;
        if (attempts >= 5) {
          await QUERIES.markDeferredCleanupFailed(task.id, String(err));
        } else {
          await QUERIES.rescheduleDeferredCleanup(
            task.id,
            attempts,
            String(err),
          );
        }
      }
    }

    return NextResponse.json({
      processed,
      total: tasks.length,
      deletedUsers,
      deletedExpiredSharedScenes: deletedSharedCount,
      deletedRemoteFiles: deletedRemote,
      deletedOrphanCategories: deletedCategoriesCount,
      deletedExpiredSessions: deletedExpiredSessionsCount,
      deletedExpiredVerifications: deletedExpiredVerificationsCount,
      purgedDeferredCleanups: purgedDeferredCleanupsCount,
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export const GET = POST; // GET 也可以觸發，方便暫時手動
