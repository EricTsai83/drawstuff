import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  scene,
  sharedScene,
  fileRecord,
  user,
  project,
  category,
  sceneCategory,
} from "./schema";

export const QUERIES = {
  // Scene 相關查詢
  getSceneById: async function (id: string) {
    const [sceneData] = await db.select().from(scene).where(eq(scene.id, id));
    return sceneData;
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

  // 僅更新場景縮圖 URL（避免覆蓋其他欄位）
  updateSceneThumbnailUrl: async function (id: string, thumbnailUrl: string) {
    return await db
      .update(scene)
      .set({
        thumbnailUrl,
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
    name,
    size,
    url,
  }: {
    sceneId?: string;
    sharedSceneId?: string;
    ownerId: string | null;
    utFileKey: string;
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

    return await db
      .insert(fileRecord)
      .values({
        sceneId: sceneId ?? null,
        sharedSceneId: sharedSceneId ?? null,
        ownerId: ownerId ?? null,
        utFileKey,
        name,
        size,
        url,
      })
      .returning();
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

  createCategory: async function ({ name }: { name: string }) {
    return await db.insert(category).values({ name }).returning();
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
};
