import {
  pgTableCreator,
  text,
  timestamp,
  boolean,
  uuid,
  varchar,
  index,
  integer,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

// 自定義 bytea 類型用於儲存二進位資料
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

export const createTable = pgTableCreator(
  (name) => `excalidraw-ericts_${name}`,
);

export const user = createTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = createTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = createTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = createTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
  updatedAt: timestamp("updated_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
});

// 新增的繪圖相關表格
export const workspace = createTable(
  "workspace",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("workspace_user_id_idx").on(table.userId),
    index("workspace_name_idx").on(table.name),
  ],
);

// 使用者預設 workspace 對應表：每位使用者僅一筆
export const userDefaultWorkspace = createTable(
  "user_default_workspace",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("user_default_workspace_user_id_idx").on(table.userId),
    index("user_default_workspace_workspace_id_idx").on(table.workspaceId),
  ],
);

// 使用者最後啟用的 workspace（後端持久化 isActive）
export const userLastActiveWorkspace = createTable(
  "user_last_active_workspace",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("user_last_active_workspace_user_id_idx").on(table.userId),
    index("user_last_active_workspace_workspace_id_idx").on(table.workspaceId),
  ],
);

export const category = createTable(
  "category",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("category_user_id_idx").on(table.userId),
    index("category_name_idx").on(table.name),
    uniqueIndex("category_user_name_unique").on(table.userId, table.name),
  ],
);

export const scene = createTable(
  "scene",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    sceneData: text("scene_data"), // 場景資料（壓縮/加密後的 base64 或 JSON 字串）
    thumbnailUrl: text("thumbnail_url"), // 新增：縮圖 URL
    thumbnailFileKey: varchar("thumbnail_file_key", { length: 256 }),
    workspaceId: uuid("workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastUpdated: timestamp("last_updated")
      .$defaultFn(() => new Date())
      .notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
    isArchived: boolean("is_archived")
      .$defaultFn(() => false)
      .notNull(), // 新增：是否已封存
  },
  (table) => [
    index("scene_user_id_idx").on(table.userId),
    index("scene_workspace_id_idx").on(table.workspaceId),
    index("scene_name_idx").on(table.name),
    index("scene_last_updated_idx").on(table.lastUpdated),
  ],
);

export const sceneCategory = createTable(
  "scene_category",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => scene.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("scene_category_scene_id_idx").on(table.sceneId),
    index("scene_category_category_id_idx").on(table.categoryId),
    index("unique_scene_category_idx").on(table.sceneId, table.categoryId),
  ],
);

export const sharedScene = createTable(
  "shared_scene",
  {
    sharedSceneId: text("shared_scene_id").primaryKey(), // 分享的 ID，如 "DpUOmthWKbgAHav1Ajtdd"
    compressedData: bytea("compressed_data"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("shared_scene_id_idx").on(table.sharedSceneId),
    index("shared_scene_created_at_idx").on(table.createdAt),
  ],
);

// 新增：文件記錄表
export const fileRecord = createTable(
  "file_record",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // 關聯到 scene 或 sharedScene（二選一）
    sceneId: uuid("scene_id").references(() => scene.id, {
      onDelete: "cascade",
    }),
    sharedSceneId: text("shared_scene_id").references(
      () => sharedScene.sharedSceneId,
      {
        onDelete: "cascade",
      },
    ),
    // 文件相關信息
    ownerId: varchar("owner_id", { length: 256 }),
    utFileKey: varchar("ut_file_key", { length: 256 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }),
    name: varchar("name", { length: 256 }).notNull(),
    size: integer("size").notNull(),
    url: varchar("url", { length: 256 }).notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("file_record_scene_id_idx").on(table.sceneId),
    index("file_record_shared_scene_id_idx").on(table.sharedSceneId),
    index("file_record_owner_id_idx").on(table.ownerId),
    index("file_record_ut_file_key_idx").on(table.utFileKey),
    // 內容去重：同一 scene 內同內容只保留一筆
    uniqueIndex("file_record_scene_content_hash_unique").on(
      table.sceneId,
      table.contentHash,
    ),
    // 唯一性：(scene_id, ut_file_key) 必須唯一，支援前端重試冪等
    uniqueIndex("file_record_scene_ut_key_unique").on(
      table.sceneId,
      table.utFileKey,
    ),
    // DB 層 XOR 約束：scene_id 與 shared_scene_id 必須且只能有一個有值
    check(
      "file_record_scene_or_shared_xor",
      sql`num_nonnulls(${table.sceneId}, ${table.sharedSceneId}) = 1`,
    ),
  ],
);

// 延遲清理任務表：記錄無法即時刪除的檔案
export const deferredFileCleanup = createTable(
  "deferred_file_cleanup",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    utFileKey: varchar("ut_file_key", { length: 256 }).notNull(),
    reason: varchar("reason", { length: 64 }).notNull(),
    context: text("context"), // JSON 字串
    attempts: integer("attempts")
      .notNull()
      .$defaultFn(() => 0),
    nextAttemptAt: timestamp("next_attempt_at")
      .notNull()
      .$defaultFn(() => new Date()),
    lastError: text("last_error"),
    status: varchar("status", { length: 16 })
      .notNull()
      .$defaultFn(() => "pending"), // pending | done | failed
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("deferred_cleanup_key_idx").on(table.utFileKey),
    index("deferred_cleanup_next_attempt_idx").on(table.nextAttemptAt),
    index("deferred_cleanup_status_idx").on(table.status),
  ],
);

// 定義表格關聯
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  workspaces: many(workspace),
  scenes: many(scene),
}));

// 新增 session 關聯定義
export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

// 新增 account 關聯定義
export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const workspaceRelations = relations(workspace, ({ one, many }) => ({
  user: one(user, {
    fields: [workspace.userId],
    references: [user.id],
  }),
  scenes: many(scene),
}));

export const userDefaultWorkspaceRelations = relations(
  userDefaultWorkspace,
  ({ one }) => ({
    user: one(user, {
      fields: [userDefaultWorkspace.userId],
      references: [user.id],
    }),
    workspace: one(workspace, {
      fields: [userDefaultWorkspace.workspaceId],
      references: [workspace.id],
    }),
  }),
);

export const userLastActiveWorkspaceRelations = relations(
  userLastActiveWorkspace,
  ({ one }) => ({
    user: one(user, {
      fields: [userLastActiveWorkspace.userId],
      references: [user.id],
    }),
    workspace: one(workspace, {
      fields: [userLastActiveWorkspace.workspaceId],
      references: [workspace.id],
    }),
  }),
);

export const sceneRelations = relations(scene, ({ one, many }) => ({
  user: one(user, {
    fields: [scene.userId],
    references: [user.id],
  }),
  workspace: one(workspace, {
    fields: [scene.workspaceId],
    references: [workspace.id],
  }),
  sceneCategories: many(sceneCategory),
  fileRecords: many(fileRecord), // 新增：文件記錄關聯
}));

export const categoryRelations = relations(category, ({ many }) => ({
  sceneCategories: many(sceneCategory),
}));

export const sceneCategoryRelations = relations(sceneCategory, ({ one }) => ({
  scene: one(scene, {
    fields: [sceneCategory.sceneId],
    references: [scene.id],
  }),
  category: one(category, {
    fields: [sceneCategory.categoryId],
    references: [category.id],
  }),
}));

export const sharedSceneRelations = relations(sharedScene, ({ many }) => ({
  fileRecords: many(fileRecord), // 新增：文件記錄關聯
}));

export const fileRecordRelations = relations(fileRecord, ({ one }) => ({
  scene: one(scene, {
    fields: [fileRecord.sceneId],
    references: [scene.id],
  }),
  sharedScene: one(sharedScene, {
    fields: [fileRecord.sharedSceneId],
    references: [sharedScene.sharedSceneId],
  }),
  owner: one(user, {
    fields: [fileRecord.ownerId],
    references: [user.id],
  }),
}));

export const schema = {
  user,
  session,
  account,
  verification,
  workspace,
  category,
  scene,
  sceneCategory,
  sharedScene,
  fileRecord, // 新增：文件記錄表
  deferredFileCleanup,
  userDefaultWorkspace,
  userLastActiveWorkspace,
};

// 導出常用型別
export type SceneRow = typeof scene.$inferSelect;
