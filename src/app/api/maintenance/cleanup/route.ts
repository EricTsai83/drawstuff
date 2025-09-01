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
    // 1) 刪除除了擁有者之外的所有使用者（連鎖刪除其資料）
    const ownerEmail = process.env.CLEANUP_OWNER_EMAIL;
    let deletedUsers = 0;
    if (ownerEmail) {
      const rows = await QUERIES.deleteUsersExceptEmail(ownerEmail);
      deletedUsers = rows.length;
    }

    // 2) 刪除一個月前的 sharedScene 與其檔案（亦會觸發 deferred 清理機制）
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldIds = await QUERIES.getSharedSceneIdsOlderThan(cutoff);
    const oldFiles = await QUERIES.getFileRecordsBySharedSceneIds(oldIds);
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
    const deletedShared = await QUERIES.deleteSharedScenesOlderThan(cutoff);

    const tasks = await QUERIES.getDueDeferredCleanups(50);
    if (tasks.length === 0) {
      return NextResponse.json({
        processed: 0,
        deletedUsers,
        deletedExpiredSharedScenes: deletedShared.length,
        deletedRemoteFiles: deletedRemote,
      });
    }

    let processed = 0;
    for (const task of tasks) {
      try {
        await utapi.deleteFiles([task.utFileKey]);
        await QUERIES.markDeferredCleanupDone(task.id);
        processed += 1;
      } catch (err) {
        const attempts = task.attempts ?? 0;
        if (attempts >= 5) {
          await QUERIES.markDeferredCleanupFailed(task.id, err);
        } else {
          await QUERIES.rescheduleDeferredCleanup(task.id, attempts, err);
        }
      }
    }

    return NextResponse.json({
      processed,
      total: tasks.length,
      deletedUsers,
      deletedExpiredSharedScenes: deletedShared.length,
      deletedRemoteFiles: deletedRemote,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export const GET = POST; // GET 也可以觸發，方便暫時手動
