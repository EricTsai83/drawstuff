import { eq, and, lte } from "drizzle-orm";
import { db } from "./index";
import {
  scene,
  sharedScene,
  fileRecord,
  user,
  project,
  category,
  sceneCategory,
  deferredFileCleanup,
} from "./schema";

export const QUERIES = {
  // Scene 相關查詢
  getSceneById: async function (id: string) {
    const [sceneData] = await db.select().from(scene).where(eq(scene.id, id));
    return sceneData;
  },

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

  getScenesByUserId: async function (userId: string) {
    return await db
      .select()
      .from(scene)
      .where(eq(scene.userId, userId))
      .orderBy(scene.lastUpdated);
  },

  createScene: async function ({
    name,
    description,
    sceneData,
    thumbnailUrl,
    projectId,
    userId,
  }: {
    name: string;
    description?: string;
    sceneData?: string;
    thumbnailUrl?: string;
    projectId?: string;
    userId: string;
  }) {
    return await db
      .insert(scene)
      .values({
        name,
        description,
        sceneData,
        thumbnailUrl,
        projectId: projectId ?? null,
        userId,
      })
      .returning();
  },

  updateScene: async function ({
    id,
    name,
    description,
    sceneData,
    thumbnailUrl,
    projectId,
  }: {
    id: string;
    name?: string;
    description?: string;
    sceneData?: string;
    thumbnailUrl?: string;
    projectId?: string;
  }) {
    return await db
      .update(scene)
      .set({
        name,
        description,
        sceneData,
        thumbnailUrl,
        projectId: projectId ?? null,
        lastUpdated: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(scene.id, id))
      .returning();
  },

  deleteScene: async function (id: string) {
    return await db.delete(scene).where(eq(scene.id, id)).returning();
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

  // SharedScene 相關查詢
  getSharedSceneById: async function (sharedSceneId: string) {
    const [sharedSceneData] = await db
      .select()
      .from(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId));
    return sharedSceneData;
  },

  createSharedScene: async function ({
    sharedSceneId,
    compressedData,
  }: {
    sharedSceneId: string;
    compressedData: Uint8Array;
  }) {
    return await db
      .insert(sharedScene)
      .values({
        sharedSceneId,
        compressedData,
      })
      .returning();
  },

  updateSharedScene: async function ({
    sharedSceneId,
    compressedData,
  }: {
    sharedSceneId: string;
    compressedData: Uint8Array;
  }) {
    return await db
      .update(sharedScene)
      .set({
        compressedData,
        updatedAt: new Date(),
      })
      .where(eq(sharedScene.sharedSceneId, sharedSceneId))
      .returning();
  },

  deleteSharedScene: async function (sharedSceneId: string) {
    return await db
      .delete(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId))
      .returning();
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

    // sharedSceneId 路徑不做唯一約束（允許相同 utFileKey 在不同分享）
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

  getFileRecordsBySceneId: async function (sceneId: string) {
    return await db
      .select()
      .from(fileRecord)
      .where(eq(fileRecord.sceneId, sceneId));
  },

  // 依 sceneId 批次刪除 file_record（回傳被刪除的筆數）
  deleteFileRecordsBySceneId: async function (sceneId: string) {
    return await db
      .delete(fileRecord)
      .where(eq(fileRecord.sceneId, sceneId))
      .returning();
  },

  // 已移除 fileKind 相關查詢（縮圖直接存在 scene）

  getFileRecordsBySharedSceneId: async function (sharedSceneId: string) {
    return await db
      .select()
      .from(fileRecord)
      .where(eq(fileRecord.sharedSceneId, sharedSceneId));
  },

  deleteFileRecord: async function (id: string) {
    return await db.delete(fileRecord).where(eq(fileRecord.id, id)).returning();
  },

  updateFileRecord: async function ({
    id,
    name,
    size,
    url,
  }: {
    id: string;
    name?: string;
    size?: number;
    url?: string;
  }) {
    return await db
      .update(fileRecord)
      .set({
        name,
        size,
        url,
        updatedAt: new Date(),
      })
      .where(eq(fileRecord.id, id))
      .returning();
  },

  // 用戶相關查詢
  getUserById: async function (id: string) {
    const [userData] = await db.select().from(user).where(eq(user.id, id));
    return userData;
  },

  getUserByEmail: async function (email: string) {
    const [userData] = await db
      .select()
      .from(user)
      .where(eq(user.email, email));
    return userData;
  },

  // 項目相關查詢
  createProject: async function ({
    name,
    description,
    userId,
  }: {
    name: string;
    description?: string;
    userId: string;
  }) {
    return await db
      .insert(project)
      .values({
        name,
        description,
        userId,
      })
      .returning();
  },

  getProjectsByUserId: async function (userId: string) {
    return await db
      .select()
      .from(project)
      .where(eq(project.userId, userId))
      .orderBy(project.updatedAt);
  },

  // 分類相關查詢
  getAllCategories: async function () {
    return await db.select().from(category).orderBy(category.name);
  },

  createCategory: async function ({
    name,
    userId,
  }: {
    name: string;
    userId: string;
  }) {
    return await db.insert(category).values({ name, userId }).returning();
  },

  // 場景分類關聯查詢
  getSceneCategories: async function (sceneId: string) {
    return await db
      .select({
        categoryId: sceneCategory.categoryId,
        categoryName: category.name,
      })
      .from(sceneCategory)
      .innerJoin(category, eq(sceneCategory.categoryId, category.id))
      .where(eq(sceneCategory.sceneId, sceneId));
  },

  addCategoryToScene: async function ({
    sceneId,
    categoryId,
  }: {
    sceneId: string;
    categoryId: string;
  }) {
    return await db
      .insert(sceneCategory)
      .values({
        sceneId,
        categoryId,
      })
      .returning();
  },

  removeCategoryFromScene: async function ({
    sceneId,
    categoryId,
  }: {
    sceneId: string;
    categoryId: string;
  }) {
    return await db
      .delete(sceneCategory)
      .where(
        eq(sceneCategory.sceneId, sceneId) &&
          eq(sceneCategory.categoryId, categoryId),
      )
      .returning();
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
};
