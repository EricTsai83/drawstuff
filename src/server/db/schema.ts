import {
  pgTableCreator,
  text,
  timestamp,
  boolean,
  uuid,
  varchar,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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

export const drawing = createTable(
  "drawing",
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
    index("drawing_user_id_idx").on(table.userId),
    index("drawing_project_id_idx").on(table.projectId),
    index("drawing_name_idx").on(table.name),
    index("drawing_last_updated_idx").on(table.lastUpdated),
  ],
);

export const drawingCategory = createTable(
  "drawing_category",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawing.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("drawing_category_drawing_id_idx").on(table.drawingId),
    index("drawing_category_category_id_idx").on(table.categoryId),
    index("unique_drawing_category_idx").on(table.drawingId, table.categoryId),
  ],
);

// 定義表格關聯
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  projects: many(project),
  drawings: many(drawing),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  user: one(user, {
    fields: [project.userId],
    references: [user.id],
  }),
  drawings: many(drawing),
}));

export const drawingRelations = relations(drawing, ({ one, many }) => ({
  user: one(user, {
    fields: [drawing.userId],
    references: [user.id],
  }),
  project: one(project, {
    fields: [drawing.projectId],
    references: [project.id],
  }),
  drawingCategories: many(drawingCategory),
}));

export const categoryRelations = relations(category, ({ many }) => ({
  drawingCategories: many(drawingCategory),
}));

export const drawingCategoryRelations = relations(
  drawingCategory,
  ({ one }) => ({
    drawing: one(drawing, {
      fields: [drawingCategory.drawingId],
      references: [drawing.id],
    }),
    category: one(category, {
      fields: [drawingCategory.categoryId],
      references: [category.id],
    }),
  }),
);

export const schema = {
  user,
  session,
  account,
  verification,
  project,
  category,
  drawing,
  drawingCategory,
};
