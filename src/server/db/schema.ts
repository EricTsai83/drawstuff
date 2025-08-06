import {
  pgTableCreator,
  text,
  timestamp,
  boolean,
  uuid,
  varchar,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
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
export const project = createTable(
  "project",
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
    index("project_user_id_idx").on(table.userId),
    index("project_name_idx").on(table.name),
  ],
);

export const category = createTable(
  "category",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: varchar("name", { length: 100 }).notNull().unique(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("category_name_idx").on(table.name)],
);

export const scene = createTable(
  "scene",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    image: text("image"), // 圖片 URL 或 base64 資料
    projectId: uuid("project_id").references(() => project.id, {
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
    index("scene_project_id_idx").on(table.projectId),
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
    ownerId: varchar("owner_id", { length: 256 }).notNull(),
    utFileKey: varchar("ut_file_key", { length: 256 }).notNull(),
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
    // 確保 sceneId 和 sharedSceneId 不能同時為空或同時有值
    // 這需要在應用層面進行驗證
  ],
);

// 定義表格關聯
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  projects: many(project),
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

export const projectRelations = relations(project, ({ one, many }) => ({
  user: one(user, {
    fields: [project.userId],
    references: [user.id],
  }),
  scenes: many(scene),
}));

export const sceneRelations = relations(scene, ({ one, many }) => ({
  user: one(user, {
    fields: [scene.userId],
    references: [user.id],
  }),
  project: one(project, {
    fields: [scene.projectId],
    references: [project.id],
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
  project,
  category,
  scene,
  sceneCategory,
  sharedScene,
  fileRecord, // 新增：文件記錄表
};
