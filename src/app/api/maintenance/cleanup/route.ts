import { NextResponse } from "next/server";
import { QUERIES } from "@/server/db/queries";
import { UTApi } from "uploadthing/server";

// 基本的清理處理器：由外部 Cron 觸發
export async function POST() {
  const utapi = new UTApi();

  try {
    const tasks = await QUERIES.getDueDeferredCleanups(50);
    if (tasks.length === 0) {
      return NextResponse.json({ processed: 0 });
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

    return NextResponse.json({ processed, total: tasks.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export const GET = POST; // GET 也可以觸發，方便暫時手動
