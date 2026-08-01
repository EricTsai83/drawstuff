import { eq, and, lte, ne, lt, inArray } from "drizzle-orm";
import { db } from "./index";
import {
  scene,
  sharedScene,
  fileRecord,
  user,
  deferredFileCleanup,
  session,
  verification,
} from "./schema";

export const QUERIES = {
  // 精簡查詢：只取擁有者 userId
  getSceneOwnerId: async function (id: string): Promise<string | undefined> {
    const [row] = await db
      .select({ ownerId: scene.userId })
      .from(scene)
      .where(eq(scene.id, id));
    return row?.ownerId;
  },

  // 精簡查詢：只取當前 thumbnailFileKey
  getSceneThumbnailKey: async function (
    id: string,
  ): Promise<string | undefined> {
    const [row] = await db
      .select({ thumbnailFileKey: scene.thumbnailFileKey })
      .from(scene)
      .where(eq(scene.id, id));
    return row?.thumbnailFileKey ?? undefined;
  },

  // 更新場景縮圖（URL 與 file key）
  updateSceneThumbnail: async function (
    id: string,
    args: { thumbnailUrl: string; thumbnailFileKey: string },
  ) {
    return await db
      .update(scene)
      .set({
        thumbnailUrl: args.thumbnailUrl,
        thumbnailFileKey: args.thumbnailFileKey,
        lastUpdated: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(scene.id, id))
      .returning();
  },

  getSharedSceneOwnerId: async function (
    sharedSceneId: string,
  ): Promise<string | undefined> {
    const [row] = await db
      .select({ ownerId: sharedScene.ownerId })
      .from(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId));
    return row?.ownerId;
  },

  // 文件記錄相關查詢
  createFileRecord: async function ({
    sceneId,
    sharedSceneId,
    ownerId,
    utFileKey,
    contentHash,
    name,
    size,
    url,
  }: {
    sceneId?: string;
    sharedSceneId?: string;
    ownerId: string | null;
    utFileKey: string;
    contentHash?: string | null;
    name: string;
    size: number;
    url: string;
  }) {
    // 驗證：sceneId 和 sharedSceneId 必須且只能有一個有值
    if (!sceneId && !sharedSceneId) {
      throw new Error("Either sceneId or sharedSceneId must be provided");
    }
    if (sceneId && sharedSceneId) {
      throw new Error("Cannot provide both sceneId and sharedSceneId");
    }

    // 冪等：sceneId 存在時，(sceneId, utFileKey) 唯一，重試不會重複寫入
    if (sceneId) {
      // 內容去重：若提供 contentHash，檢查同 scene 是否已存在
      if (contentHash) {
        const existing = await QUERIES.getFileRecordBySceneAndContentHash(
          sceneId,
          contentHash,
        );
        if (existing) {
          return [] as const;
        }
      }
      return await db
        .insert(fileRecord)
        .values({
          sceneId,
          sharedSceneId: null,
          ownerId: ownerId ?? null,
          utFileKey,
          contentHash: contentHash ?? null,
          name,
          size,
          url,
        })
        .onConflictDoNothing({
          target: [fileRecord.sceneId, fileRecord.utFileKey],
        })
        .returning();
    }

    // sharedSceneId 路徑以檔名保存 Excalidraw file id，支援重試冪等
    return await db
      .insert(fileRecord)
      .values({
        sceneId: null,
        sharedSceneId: sharedSceneId ?? null,
        ownerId: ownerId ?? null,
        utFileKey,
        contentHash: null,
        name,
        size,
        url,
      })
      .onConflictDoNothing({
        target: [fileRecord.sharedSceneId, fileRecord.name],
      })
      .returning();
  },

  getFileRecordBySceneAndContentHash: async function (
    sceneId: string,
    contentHash: string,
  ) {
    const [row] = await db
      .select()
      .from(fileRecord)
      .where(
        and(
          eq(fileRecord.sceneId, sceneId),
          eq(fileRecord.contentHash, contentHash),
        ),
      );
    return row;
  },

  deleteFileRecordsBySceneIdAndFileKeys: async function (
    sceneId: string,
    fileKeys: string[],
  ) {
    if (fileKeys.length === 0)
      return [] as Array<typeof fileRecord.$inferSelect>;
    return await db
      .delete(fileRecord)
      .where(
        and(
          eq(fileRecord.sceneId, sceneId),
          inArray(fileRecord.utFileKey, fileKeys),
        ),
      )
      .returning();
  },

  getFileRecordsBySharedSceneId: async function (sharedSceneId: string) {
    return await db
      .select()
      .from(fileRecord)
      .where(eq(fileRecord.sharedSceneId, sharedSceneId));
  },

  // 延遲清理任務相關
  enqueueDeferredCleanup: async function ({
    utFileKey,
    reason,
    context,
  }: {
    utFileKey: string;
    reason: string;
    context?: unknown;
  }) {
    const payload = {
      utFileKey,
      reason,
      context: context ? JSON.stringify(context) : null,
      attempts: 0,
      nextAttemptAt: new Date(),
      status: "pending" as const,
    };
    return await db.insert(deferredFileCleanup).values(payload).returning();
  },

  getDueDeferredCleanups: async function (limit = 50) {
    const now = new Date();
    return await db
      .select()
      .from(deferredFileCleanup)
      .where(
        and(
          eq(deferredFileCleanup.status, "pending"),
          lte(deferredFileCleanup.nextAttemptAt, now),
        ),
      )
      .limit(limit);
  },

  markDeferredCleanupDone: async function (id: string) {
    return await db
      .update(deferredFileCleanup)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(deferredFileCleanup.id, id))
      .returning();
  },

  rescheduleDeferredCleanup: async function (
    id: string,
    attempts: number,
    lastError?: unknown,
  ) {
    const nextDelayMs = Math.min(60_000, 1_000 * 2 ** attempts); // 指數退避，上限 60s
    const next = new Date(Date.now() + nextDelayMs);
    return await db
      .update(deferredFileCleanup)
      .set({
        attempts: attempts + 1,
        lastError: lastError
          ? typeof lastError === "string"
            ? lastError
            : JSON.stringify(lastError)
          : null,
        nextAttemptAt: next,
        updatedAt: new Date(),
      })
      .where(eq(deferredFileCleanup.id, id))
      .returning();
  },

  markDeferredCleanupFailed: async function (id: string, lastError?: unknown) {
    return await db
      .update(deferredFileCleanup)
      .set({
        status: "failed",
        lastError: lastError
          ? typeof lastError === "string"
            ? lastError
            : JSON.stringify(lastError)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(deferredFileCleanup.id, id))
      .returning();
  },
  // 清理：刪除除了擁有者之外的所有使用者（連鎖刪除其關聯資料）
  deleteUsersExceptEmail: async function (ownerEmail: string) {
    return await db.delete(user).where(ne(user.email, ownerEmail)).returning();
  },

  // 清理前置：取得除了擁有者之外的所有使用者 ID
  getUserIdsExceptEmail: async function (ownerEmail: string) {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(ne(user.email, ownerEmail));
    return rows.map((r) => r.id);
  },

  // 清理前置：取得屬於多位使用者的場景 ID
  getSceneIdsByUserIds: async function (userIds: string[]) {
    if (userIds.length === 0) return [] as string[];
    const rows = await db
      .select({ id: scene.id })
      .from(scene)
      .where(inArray(scene.userId, userIds));
    return rows.map((r) => r.id);
  },

  // 清理前置：取得多位使用者的場景縮圖 key（非空）
  getSceneThumbnailKeysByUserIds: async function (userIds: string[]) {
    if (userIds.length === 0) return [] as string[];
    const rows = await db
      .select({ key: scene.thumbnailFileKey })
      .from(scene)
      .where(inArray(scene.userId, userIds));
    return rows.map((r) => r.key).filter((k): k is string => !!k);
  },

  // 清理前置：依 ownerIds 取得 file_record 的 utFileKey
  getFileKeysByOwnerIds: async function (ownerIds: string[]) {
    if (ownerIds.length === 0) return [] as string[];
    const rows = await db
      .select({ key: fileRecord.utFileKey })
      .from(fileRecord)
      .where(inArray(fileRecord.ownerId, ownerIds));
    return rows.map((r) => r.key);
  },

  // 清理前置：依 sceneIds 取得 file_record 的 utFileKey
  getFileKeysBySceneIds: async function (sceneIds: string[]) {
    if (sceneIds.length === 0) return [] as string[];
    const rows = await db
      .select({ key: fileRecord.utFileKey })
      .from(fileRecord)
      .where(inArray(fileRecord.sceneId, sceneIds));
    return rows.map((r) => r.key);
  },

  // 清理：取得早於指定時間的 sharedScene IDs
  getSharedSceneIdsOlderThan: async function (cutoff: Date) {
    const rows = await db
      .select({ id: sharedScene.sharedSceneId })
      .from(sharedScene)
      .where(lt(sharedScene.createdAt, cutoff));
    return rows.map((r) => r.id);
  },

  // 清理：批次查詢 sharedSceneIds 對應的檔案紀錄
  getFileRecordsBySharedSceneIds: async function (sharedSceneIds: string[]) {
    if (sharedSceneIds.length === 0)
      return [] as Array<typeof fileRecord.$inferSelect>;
    return await db
      .select()
      .from(fileRecord)
      .where(inArray(fileRecord.sharedSceneId, sharedSceneIds));
  },

  // 清理：刪除早於指定時間的 sharedScene（連鎖刪除其檔案紀錄）
  deleteSharedScenesOlderThan: async function (cutoff: Date) {
    return await db
      .delete(sharedScene)
      .where(lt(sharedScene.createdAt, cutoff))
      .returning();
  },

  // 清理：刪除已過期的 sessions（expiresAt < now）
  deleteExpiredSessions: async function (now = new Date()) {
    return await db
      .delete(session)
      .where(lt(session.expiresAt, now))
      .returning();
  },

  // 清理：刪除已過期的驗證碼（verification.expiresAt < now）
  deleteExpiredVerifications: async function (now = new Date()) {
    return await db
      .delete(verification)
      .where(lt(verification.expiresAt, now))
      .returning();
  },

  // 清理：刪除已完成/失敗且早於 cutoff 的延遲清理任務
  purgeDeferredFileCleanupOlderThan: async function (
    cutoff: Date,
    statuses: Array<"done" | "failed"> = ["done", "failed"],
  ) {
    return await db
      .delete(deferredFileCleanup)
      .where(
        and(
          inArray(deferredFileCleanup.status, statuses),
          lt(deferredFileCleanup.updatedAt, cutoff),
        ),
      )
      .returning();
  },
};
