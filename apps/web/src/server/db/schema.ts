// 刻意沒有 `import "server-only"`：這個檔案是 drizzle-kit 的 schema 入口
// （drizzle.config.ts），drizzle-kit 在一般 Node 條件下載入它，server-only 會
// 直接 throw、`db:push` 隨之失效。這裡只有表定義，沒有連線與秘密；真正開
// live 連線的 `./index.ts` 才掛 guard，client bundle 只要碰到 db 就會炸。
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
  primaryKey,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import { DRAWSTUFF_DOCUMENT_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_URL_LENGTH,
  MIN_ASSET_BYTES,
} from "@drawstuff/collaboration/asset";
import { MAX_SNAPSHOT_BYTES } from "@drawstuff/collaboration/snapshot";
import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";
import {
  PERSONAL_LIBRARY_FORMAT_VERSION,
  PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES,
} from "@/lib/personal-library";

const createTable = pgTableCreator((name) => `drawstuff_${name}`);

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

/** One durable, scene-independent Excalidraw Library snapshot per user. */
export const personalLibrary = createTable(
  "personal_library",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    revision: integer("revision").default(1).notNull(),
    formatVersion: integer("format_version")
      .default(PERSONAL_LIBRARY_FORMAT_VERSION)
      .notNull(),
    compressedData: bytea("compressed_data").notNull(),
    byteLength: integer("byte_length").notNull(),
    checksum: varchar("checksum", { length: 64 }).notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    check("personal_library_revision_positive", sql`${table.revision} >= 1`),
    check(
      "personal_library_format_version_supported",
      sql`${table.formatVersion} = ${sql.raw(
        String(PERSONAL_LIBRARY_FORMAT_VERSION),
      )}`,
    ),
    check(
      "personal_library_byte_length_matches",
      sql`${table.byteLength} = octet_length(${table.compressedData})`,
    ),
    check(
      "personal_library_byte_length_bounded",
      sql`${table.byteLength} between 1 and ${sql.raw(
        String(PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES),
      )}`,
    ),
    check(
      "personal_library_checksum_shape",
      sql`${table.checksum} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

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

/** Durable privileged-role assignment. Email is never an authorization key. */
export const adminGrant = createTable(
  "admin_grant",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).default("operator").notNull(),
    grantSource: varchar("grant_source", { length: 32 }).notNull(),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at")
      .$defaultFn(() => new Date())
      .notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("admin_grant_active_idx").on(table.role, table.revokedAt),
    check("admin_grant_role_supported", sql`${table.role} = 'operator'`),
    check(
      "admin_grant_source_supported",
      sql`${table.grantSource} in ('bootstrap', 'operator')`,
    ),
  ],
);

/** Append-oriented security audit retained independently of a deleted target account. */
export const adminAuditEvent = createTable(
  "admin_audit_event",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorUserId: text("actor_user_id"),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    targetId: text("target_id").notNull(),
    status: varchar("status", { length: 16 }).default("started").notNull(),
    error: text("error"),
    occurredAt: timestamp("occurred_at")
      .$defaultFn(() => new Date())
      .notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("admin_audit_actor_time_idx").on(table.actorUserId, table.occurredAt),
    index("admin_audit_target_idx").on(table.targetType, table.targetId),
    check(
      "admin_audit_status_supported",
      sql`${table.status} in ('started', 'succeeded', 'failed')`,
    ),
  ],
);

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
    workspaceId: uuid("workspace_id").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "default_workspace_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
    }).onDelete("restrict"),
    index("user_default_workspace_user_id_idx").on(table.userId),
    index("user_default_workspace_workspace_id_idx").on(table.workspaceId),
  ],
);

// 使用者最後啟用的 workspace（後端持久化 isActive）
export const userLastActiveWorkspace = createTable(
  "user_last_active_workspace",
  {
    userId: text("user_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "last_workspace_user_fk",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "last_workspace_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
    }).onDelete("restrict"),
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
    documentVersion: integer("document_version")
      .default(DRAWSTUFF_DOCUMENT_VERSION)
      .notNull(),
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
    revision: integer("revision").default(1).notNull(),
    isArchived: boolean("is_archived")
      .$defaultFn(() => false)
      .notNull(), // 新增：是否已封存
    isPublished: boolean("is_published").default(false).notNull(),
    publishedSlug: varchar("published_slug", { length: 64 }),
    publishedAt: timestamp("published_at"),
    // 已發布場景的渲染成品（docs/system-design/render-once-serve-many.md）：作者瀏覽器在
    // 儲存／發布時以引擎匯出 SVG 上傳，`/p/[slug]` 只下載成品、不載入引擎。
    // 淺色與深色共用同一份檔案：兩種主題的差異只有少數屬性，成品把它們記成
    // overrides，viewer 切換主題不需要再下載一次。替換時舊 key 在同一交易入
    // deferred_file_cleanup。引擎版本與渲染時的 revision 讓過時成品可偵測、
    // 亂序的 setPublishedArtifacts 不會蓋掉較新成品。
    publishedSvgKey: varchar("published_svg_key", { length: 256 }),
    publishedSvgUrl: text("published_svg_url"),
    publishedRenderEngineVersion: varchar("published_render_engine_version", {
      length: 32,
    }),
    publishedRenderedRevision: integer("published_rendered_revision"),
    publishedRenderedAt: timestamp("published_rendered_at"),
  },
  (table) => [
    index("scene_user_id_idx").on(table.userId),
    index("scene_workspace_id_idx").on(table.workspaceId),
    // Dashboard keyset pagination：userId 等值 + (updatedAt, id) 降冪，cursor
    // 條件走 index range。名稱／last_updated 的單欄索引已移除：搜尋是
    // leading-wildcard ilike（用不到 btree），也沒有查詢以 last_updated 排序。
    index("scene_user_updated_idx").on(
      table.userId,
      table.updatedAt.desc(),
      table.id.desc(),
    ),
    index("scene_published_idx").on(table.isPublished),
    uniqueIndex("scene_published_slug_unique").on(table.publishedSlug),
    check("scene_revision_positive", sql`${table.revision} >= 1`),
    // key 與 URL 同進同出：只有一邊等於沒有成品可指。
    check(
      "scene_published_artifact_complete",
      sql`(${table.publishedSvgKey} is null) = (${table.publishedSvgUrl} is null)`,
    ),
    check(
      "scene_document_version_supported",
      sql`${table.documentVersion} in (2, 3, ${sql.raw(
        String(DRAWSTUFF_DOCUMENT_VERSION),
      )})`,
    ),
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
    uniqueIndex("unique_scene_category_idx").on(
      table.sceneId,
      table.categoryId,
    ),
  ],
);

/**
 * 共編 room 的 web 端紀錄：storage fence、初始化 manifest 與列表顯示用的副本。
 * 存取權由 Durable Object 的 Room authority 決定，這張表不授予任何權限。
 *
 * 房間結束後這一列保留（`status='ended'`）：DO 在房間結束並處理完後會刪掉
 * 自己的儲存，這一列和 `collaboration_creation_fence` 是「這個 roomId 用過」的
 * 唯一紀錄，建房註冊靠它拒絕重用 roomId。
 */
export const collaborationRoom = createTable(
  "collaboration_room",
  {
    // relay 用的 room id（nanoid），同時是主鍵：不另外維護第二組識別碼。
    roomId: varchar("room_id", { length: 64 }).primaryKey(),
    sceneId: uuid("scene_id").references(() => scene.id, {
      onDelete: "cascade",
    }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * 單調遞增的授權版本：每次成員／生命週期變更都在 row lock 下 +1。cutoff 用
     * 版本而不是時間排序，等鎖的請求才不會發出比自己還舊的 cutoff，重新授權後
     * 簽出的 token 也一定高於該次 cutoff。
     */
    authRevision: integer("auth_revision").default(1).notNull(),
    /**
     * 建房時的一般存取權（`none` 只有受邀的人、`viewer`／`editor` 有連結的人）。
     * 之後的變更只存在 Room authority；這裡是建立當下的副本。
     */
    linkRole: varchar("link_role", { length: 16 }).default("none").notNull(),
    status: varchar("status", { length: 16 }).default("initializing").notNull(),
    authorityEpoch: integer("authority_epoch").default(1).notNull(),
    /** Adapter fence is independent of the display projection and DB role copies. */
    storageState: varchar("storage_state", { length: 16 })
      .default("initializing")
      .notNull(),
    snapshotRevision: integer("snapshot_revision").default(0).notNull(),
    projectionVersion: integer("projection_version").default(1).notNull(),
    label: varchar("label", { length: 120 }).default("").notNull(),
    createOperationId: uuid("create_operation_id")
      .$defaultFn(() => crypto.randomUUID())
      .notNull()
      .unique(),
    initializationDeadline: timestamp("initialization_deadline")
      .default(sql`now() + interval '15 minutes'`)
      .notNull(),
    initializationAssetIds: text("initialization_asset_ids")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    initializationRevision: integer("initialization_revision"),
    initializationChecksum: varchar("initialization_checksum", { length: 64 }),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("collaboration_room_owner_id_idx").on(table.ownerId),
    index("collaboration_room_status_ended_at_idx").on(
      table.status,
      table.endedAt,
    ),
    check(
      "collaboration_room_authority_epoch_positive",
      sql`${table.authorityEpoch} >= 1`,
    ),
    check(
      "collaboration_room_storage_fence",
      sql`${table.snapshotRevision}>=0 and ${table.storageState} in ('initializing','ready','ended')`,
    ),
    check(
      "collaboration_room_projection_version_positive",
      sql`${table.projectionVersion} >= 1`,
    ),
    check(
      "collaboration_room_initialization_assets_bounded",
      sql`cardinality(${table.initializationAssetIds}) <= ${sql.raw(String(AUTHORITY_LIMITS.initializationAssets))}`,
    ),
    check(
      "collaboration_room_initialization_checksum",
      sql`${table.initializationChecksum} is null or ${table.initializationChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "collaboration_room_initialization_manifest",
      sql`(${table.initializationRevision} is null) = (${table.initializationChecksum} is null) and (${table.initializationRevision} is null or ${table.initializationRevision} > 0)`,
    ),
    // 同一個 scene 最多一個 active room；ended room 保留為歷史紀錄。
    // A new name lets db:push replace protocol-5's status='active' predicate.
    uniqueIndex("collaboration_room_active_scene_unique_v6")
      .on(table.sceneId)
      .where(sql`status in ('initializing', 'ready')`),
    check(
      "collaboration_room_auth_revision_positive",
      sql`${table.authRevision} >= 1`,
    ),
    check(
      "collaboration_room_status_supported_v6",
      sql`${table.status} in ('initializing', 'ready', 'ended')`,
    ),
    check(
      "collaboration_room_link_role_supported",
      sql`${table.linkRole} in ('none', 'viewer', 'editor')`,
    ),
  ],
);

/**
 * 以帳號為鍵的房間列表副本（Room authority 的 `projection` 事件）：擁有者與
 * 開啟過房間的人。只供列表顯示，絕不用來授權。`access` 決定它出現在哪一區
 * （`owned`／`invited` → 我擁有的與受邀的，`link` → 透過連結開啟過的）；
 * `revokedAt` 不為 null 代表 tombstone（失去存取權、離開、房間結束），此時
 * `role`／`access` 為 null。
 */
export const collaborationRoomMember = createTable(
  "collaboration_room_member",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: varchar("room_id", { length: 64 }).notNull(),
    userId: text("user_id").notNull(),
    role: varchar("role", { length: 16 }),
    access: varchar("access", { length: 16 }),
    revokedAt: timestamp("revoked_at"),
    projectionVersion: integer("projection_version").default(1).notNull(),
    listedAt: timestamp("listed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "collab_member_room_fk",
      columns: [table.roomId],
      foreignColumns: [collaborationRoom.roomId],
    }).onDelete("cascade"),
    foreignKey({
      name: "collab_member_user_fk",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    // join 時是 (room, user) 單筆查詢；唯一索引同時擋掉重複 membership。
    uniqueIndex("collaboration_room_member_room_user_unique").on(
      table.roomId,
      table.userId,
    ),
    index("collaboration_room_member_user_listed_idx").on(
      table.userId,
      table.listedAt.desc(),
      table.roomId.desc(),
    ),
    check(
      "collaboration_room_member_projection_version_positive",
      sql`${table.projectionVersion} >= 1`,
    ),
    check(
      "collaboration_room_member_role_supported",
      sql`${table.role} is null or ${table.role} in ('owner', 'editor', 'viewer')`,
    ),
    check(
      "collaboration_room_member_access_supported",
      sql`${table.access} is null or ${table.access} in ('owned', 'invited', 'link')`,
    ),
    check(
      "collaboration_room_member_live_shape",
      sql`(${table.revokedAt} is null) = (${table.role} is not null and ${table.access} is not null)`,
    ),
  ],
);

/**
 * 以正規化 email 為鍵的邀請列表副本（Room authority 的 `invite-projection`
 * 事件），讓受邀但還沒開啟過的房間也能出現在「我擁有的與受邀的」。只供列表
 * 顯示，絕不用來授權。`role` 是邀請目前給的角色（邀請與一般存取權取較高者）；
 * 邀請被移除或房間結束時 `revokedAt` 不為 null、`role` 為 null。
 */
export const collaborationRoomInvite = createTable(
  "collaboration_room_invite",
  {
    roomId: varchar("room_id", { length: 64 }).notNull(),
    emailKey: varchar("email_key", { length: 254 }).notNull(),
    role: varchar("role", { length: 16 }),
    revokedAt: timestamp("revoked_at"),
    projectionVersion: integer("projection_version").notNull(),
    listedAt: timestamp("listed_at").notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "collab_invite_room_fk",
      columns: [table.roomId],
      foreignColumns: [collaborationRoom.roomId],
    }).onDelete("cascade"),
    primaryKey({
      name: "collaboration_room_invite_pk",
      columns: [table.roomId, table.emailKey],
    }),
    index("collaboration_room_invite_email_listed_idx").on(
      table.emailKey,
      table.listedAt.desc(),
      table.roomId.desc(),
    ),
    check(
      "collaboration_room_invite_projection_version_positive",
      sql`${table.projectionVersion} >= 1`,
    ),
    check(
      "collaboration_room_invite_role_shape",
      sql`(${table.revokedAt} is null) = (${table.role} is not null) and (${table.role} is null or ${table.role} in ('owner', 'editor', 'viewer'))`,
    ),
  ],
);

/**
 * 共編 room 的持久化 snapshot。room 的所有 client 離線或 relay restart
 * 之後，後來加入的人就是從這裡取得 baseline。
 *
 * `data` 是 `encodeCollaborationSnapshot` 的明文 bytes：房間不做端對端加密，
 * 與「我的場景」一樣靠登入與存取規則保護（plan 21）。每個 room 一列，
 * `revision` 擋掉舊 snapshot 覆寫新 snapshot。
 *
 * 這和 owned-scene V4 save 是兩個互不覆寫的 lifecycle（ADR 0001）：那一份由場景
 * 擁有者按下儲存時寫入 `scene.scene_data`，這一份由 room 內被選出的參與者定期
 * 寫入，兩者永遠不會互相蓋掉。
 */
export const collaborationSnapshot = createTable(
  "collaboration_snapshot",
  {
    roomId: varchar("room_id", { length: 64 }).primaryKey(),
    /** 每次成功寫入 +1；conditional write 用它擋掉舊 snapshot 覆寫新 snapshot。 */
    revision: integer("revision").notNull(),
    data: bytea("data").notNull(),
    /** 位元長度；和 `octet_length` 的 check 一起把單列大小限制住。 */
    byteLength: integer("byte_length").notNull(),
    /** `data` 的 SHA-256 hex：偵測傳輸或儲存層損壞。 */
    checksum: varchar("checksum", { length: 64 }).notNull(),
    /** 最後一次成功寫入的成員；成員被刪除時保留 snapshot。 */
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "collab_snapshot_room_fk",
      columns: [table.roomId],
      foreignColumns: [collaborationRoom.roomId],
    }).onDelete("cascade"),
    foreignKey({
      name: "collab_snapshot_updated_by_fk",
      columns: [table.updatedBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    check(
      "collaboration_snapshot_revision_positive",
      sql`${table.revision} >= 1`,
    ),
    // 位元長度必須與資料一致，且不得超過 `MAX_SNAPSHOT_BYTES`：
    // 授權成員也不能靠 snapshot 無界地長大資料庫。
    check(
      "collaboration_snapshot_byte_length_matches",
      sql`${table.byteLength} = octet_length(${table.data})`,
    ),
    check(
      "collaboration_snapshot_byte_length_bounded",
      sql`${table.byteLength} between 1 and ${sql.raw(
        String(MAX_SNAPSHOT_BYTES),
      )}`,
    ),
  ],
);

/**
 * 共編 room 的 binary asset：身份與 bytes 所在位置。
 *
 * 一列代表「這個 room 有這個 Excalidraw file id 的圖片，存在這個 storage
 * object」。身份是 (room, `excalidraw_file_id`)，`ut_file_key`／`url` 只是
 * 「現在存在哪裡」——重新上傳會得到新 key，所以它不是身份，只能由身份反查出來。
 *
 * 這張表**沒有純身份的列**：一列存在就代表位元組已經上傳完成，讀取端才能區分
 * 「還沒上傳」與「不存在」。
 *
 * 內容是 `encodeCollaborationAssetPayload` 的明文 bytes，放在 UploadThing 的
 * public URL，暴露程度與個人場景圖片相同（ADR-0005、plan 21 D6）。
 *
 * 為什麼不放進 `file_record`：那張表的 parent 是 scene／sharedScene、retention
 * 跟著 scene 走。Room asset 的 parent 是 room、retention 跟著 room 走，而 writer
 * 可能是非 scene owner 的 editor（見 ADR 0001 的 asset relation boundary）。
 */
export const collaborationAsset = createTable(
  "collaboration_asset",
  {
    roomId: varchar("room_id", { length: 64 }).notNull(),
    /** 不可變的 Excalidraw file id；在 room 內唯一。 */
    excalidrawFileId: varchar("excalidraw_file_id", { length: 64 }).notNull(),
    /** Storage object 身份；清理與去重都用它。 */
    utFileKey: varchar("ut_file_key", { length: 256 }).notNull(),
    /**
     * 目前的下載位置；不是身份，重新上傳會變。長度與
     * `MAX_ASSET_URL_LENGTH` 同步：transfer contract 拒收的 URL 這裡也存不下。
     */
    url: varchar("url", { length: MAX_ASSET_URL_LENGTH }).notNull(),
    /** Payload 長度；下載前的上界檢查，與 `MAX_ASSET_BYTES` 一起設限。 */
    byteLength: integer("byte_length").notNull(),
    /** 上傳者；成員被刪除時保留資產（身份與上傳者無關）。 */
    registeredBy: text("registered_by"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "collab_asset_room_fk",
      columns: [table.roomId],
      foreignColumns: [collaborationRoom.roomId],
    }).onDelete("cascade"),
    foreignKey({
      name: "collab_asset_registered_by_fk",
      columns: [table.registeredBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    primaryKey({
      name: "collaboration_asset_room_file_pk",
      columns: [table.roomId, table.excalidrawFileId],
    }),
    check(
      "collaboration_asset_excalidraw_file_id_shape",
      sql`${table.excalidrawFileId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    // 授權成員也不能靠 asset 無界地長大 storage：單一資產的長度有上界。
    check(
      "collaboration_asset_byte_length_bounded",
      sql`${table.byteLength} between ${sql.raw(String(MIN_ASSET_BYTES))} and ${sql.raw(
        String(MAX_ASSET_BYTES),
      )}`,
    ),
  ],
);

/** Terminal creation barrier survives missing parents and their cascades. */
export const collaborationCreationFence = createTable(
  "collaboration_creation_fence",
  {
    roomId: varchar("room_id", { length: 64 }).primaryKey(),
    ended: boolean("ended").default(false).notNull(),
  },
);

/** Adapter result and snapshot commit share the room's FOR UPDATE fence. No payload here. */
export const collaborationOperation = createTable(
  "collaboration_operation",
  {
    operationId: uuid("operation_id").primaryKey(),
    roomId: varchar("room_id", { length: 64 })
      .notNull()
      .references(() => collaborationRoom.roomId, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    authorityEpoch: integer("authority_epoch").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    checksum: varchar("checksum", { length: 64 }).notNull(),
    /** Digest of the complete canonical intent, including immutable asset metadata and deadline. */
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    assetId: varchar("asset_id", { length: 64 }),
    utFileKey: varchar("ut_file_key", { length: 256 }),
    deadline: timestamp("deadline").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    revision: integer("revision"),
    terminalAt: timestamp("terminal_at"),
  },
  (table) => [
    index("collaboration_operation_terminal_idx").on(table.terminalAt),
    check(
      "collaboration_operation_kind",
      sql`${table.kind} in ('snapshot-put','snapshot-reset','asset-finalize')`,
    ),
    check(
      "collaboration_operation_status",
      sql`${table.status} in ('pending','written','cancelled','refused','conflict')`,
    ),
    check(
      "collaboration_operation_versions",
      sql`${table.authorityEpoch}>0 and ${table.expectedRevision}>=0`,
    ),
    check(
      "collaboration_operation_checksum",
      sql`${table.checksum} ~ '^[a-f0-9]{64}$' and ${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "collaboration_operation_asset_identity",
      sql`(${table.kind}='asset-finalize') = (${table.assetId} is not null) and (${table.assetId} is null) = (${table.utFileKey} is null)`,
    ),
    check(
      "collaboration_operation_result",
      sql`(${table.status}='written') = (${table.revision} is not null) and (${table.revision} is null or ${table.revision}>0) and (${table.status}='pending') = (${table.terminalAt} is null)`,
    ),
  ],
);

/** Terminal subject fences outlive cascades; subject ids are never reused. */
export const collaborationLifecycleSubject = createTable(
  "collaboration_lifecycle_subject",
  {
    scope: varchar("scope", { length: 160 }).primaryKey(),
    kind: varchar("kind", { length: 16 }).notNull(),
    subject: text("subject").notNull(),
    sceneId: uuid("scene_id"),
    version: integer("version").default(1).notNull(),
    frozen: boolean("frozen").default(false).notNull(),
    retired: boolean("retired").default(false).notNull(),
    operationId: uuid("operation_id"),
  },
  (table) => [
    check(
      "collaboration_lifecycle_subject_shape",
      sql`(${table.kind}='account' and ${table.sceneId} is null and ${table.scope}='account:' || ${table.subject}) or (${table.kind}='scene' and ${table.sceneId} is not null and ${table.scope}='scene:' || ${table.sceneId}::text)`,
    ),
    check("collaboration_lifecycle_subject_version", sql`${table.version}>0`),
    check(
      "collaboration_lifecycle_subject_retired_frozen",
      sql`not ${table.retired} or ${table.frozen}`,
    ),
  ],
);

/** Reliable pre-activation registration includes rooms still being created (so no room FK). */
export const collaborationLifecycleRegistration = createTable(
  "collaboration_lifecycle_registration",
  {
    subject: text("subject").notNull(),
    roomId: varchar("room_id", { length: 64 }).notNull(),
    sceneId: uuid("scene_id"),
    owner: boolean("owner").notNull(),
    lifecycleVersion: integer("lifecycle_version").notNull(),
    operationId: uuid("operation_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subject, table.roomId] }),
    index("collaboration_lifecycle_registration_scene_idx").on(
      table.sceneId,
      table.roomId,
    ),
    check(
      "collaboration_lifecycle_registration_version",
      sql`${table.lifecycleVersion}>0`,
    ),
  ],
);

/** Monotonic negative projection survives a deleted account/room and refuses delayed events. */
export const collaborationProjectionTombstone = createTable(
  "collaboration_projection_tombstone",
  {
    roomId: varchar("room_id", { length: 64 }).notNull(),
    subject: text("subject").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.subject] }),
    check(
      "collaboration_projection_tombstone_version",
      sql`${table.version}>0`,
    ),
  ],
);

export const sharedScene = createTable(
  "shared_scene",
  {
    sharedSceneId: text("shared_scene_id").primaryKey(), // 分享的 ID，如 "DpUOmthWKbgAHav1Ajtdd"
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    compressedData: bytea("compressed_data"),
    documentVersion: integer("document_version")
      .default(DRAWSTUFF_DOCUMENT_VERSION)
      .notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("shared_scene_id_idx").on(table.sharedSceneId),
    index("shared_scene_owner_id_idx").on(table.ownerId),
    index("shared_scene_created_at_idx").on(table.createdAt),
    check(
      "shared_scene_document_version_supported",
      sql`${table.documentVersion} in (2, 3, ${sql.raw(
        String(DRAWSTUFF_DOCUMENT_VERSION),
      )})`,
    ),
  ],
);

/**
 * 已上傳到外部 object storage 的 scene／sharedScene 資產紀錄。
 *
 * 身份是 **parent scope + `excalidraw_file_id`**：Excalidraw 的 file id
 * 是圖片位元組的摘要，由 engine 產生且不可變，元素上的 `fileId` 也只認這個值。
 * 先前用 `(scene_id, content_hash)` 當身份是錯的——hash 取自「壓縮後的上傳
 * payload」，而 payload metadata 帶 `created`／`lastRetrieved` 時間戳，於是每次
 * 存檔都算出新 hash、去重永不命中，同一張圖每存一次就多一列與一個孤兒 object。
 *
 * 兩個欄位刻意不是身份：
 *
 * - `content_hash` 只是 storage 層的 lookup／dedup 提示，可為 null，沒有唯一性。
 * - `ut_file_key` 是 storage object 的身份，不是 Excalidraw 的身份；同一張圖重新
 *   上傳會得到新 key，所以它無法用來判斷「這張圖是否已經在這個 scene 裡」。
 */
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
    sharedSceneId: text("shared_scene_id"),
    // 文件相關信息
    ownerId: varchar("owner_id", { length: 256 }),
    utFileKey: varchar("ut_file_key", { length: 256 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }),
    /** 不可變的 Excalidraw file id；與 parent scope 一起構成資產身份。 */
    excalidrawFileId: varchar("excalidraw_file_id", { length: 64 }).notNull(),
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
    foreignKey({
      name: "file_record_shared_scene_fk",
      columns: [table.sharedSceneId],
      foreignColumns: [sharedScene.sharedSceneId],
    }).onDelete("cascade"),
    index("file_record_scene_id_idx").on(table.sceneId),
    index("file_record_shared_scene_id_idx").on(table.sharedSceneId),
    index("file_record_owner_id_idx").on(table.ownerId),
    index("file_record_ut_file_key_idx").on(table.utFileKey),
    // 身份唯一性，同時是上傳重試的冪等依據：同一個 file id 重試只會有一列。
    uniqueIndex("file_record_scene_excalidraw_file_id_unique").on(
      table.sceneId,
      table.excalidrawFileId,
    ),
    uniqueIndex("file_record_shared_scene_excalidraw_file_id_unique").on(
      table.sharedSceneId,
      table.excalidrawFileId,
    ),
    // DB 層 XOR 約束：scene_id 與 shared_scene_id 必須且只能有一個有值
    check(
      "file_record_scene_or_shared_xor",
      sql`num_nonnulls(${table.sceneId}, ${table.sharedSceneId}) = 1`,
    ),
    // 身份不得是空字串或任意字元：SHA-1 hex 與 upstream 的 `nanoid(40)` fallback
    // 都落在這個字元集內。
    check(
      "file_record_excalidraw_file_id_shape",
      sql`${table.excalidrawFileId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
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
    // Drain 熱查詢是 status='pending' AND next_attempt_at <= now ORDER BY
    // next_attempt_at：複合索引讓每批直接走 index range，取代原本兩個單欄索引
    // 的 bitmap-AND + sort。
    index("deferred_cleanup_status_next_attempt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

// 定義表格關聯
export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  accounts: many(account),
  workspaces: many(workspace),
  scenes: many(scene),
  sharedScenes: many(sharedScene),
  personalLibrary: one(personalLibrary),
}));

export const personalLibraryRelations = relations(
  personalLibrary,
  ({ one }) => ({
    user: one(user, {
      fields: [personalLibrary.userId],
      references: [user.id],
    }),
  }),
);

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
  collaborationRooms: many(collaborationRoom),
}));

export const collaborationRoomRelations = relations(
  collaborationRoom,
  ({ one, many }) => ({
    scene: one(scene, {
      fields: [collaborationRoom.sceneId],
      references: [scene.id],
    }),
    owner: one(user, {
      fields: [collaborationRoom.ownerId],
      references: [user.id],
    }),
    members: many(collaborationRoomMember),
    snapshots: many(collaborationSnapshot),
    assets: many(collaborationAsset),
  }),
);

export const collaborationAssetRelations = relations(
  collaborationAsset,
  ({ one }) => ({
    room: one(collaborationRoom, {
      fields: [collaborationAsset.roomId],
      references: [collaborationRoom.roomId],
    }),
    registeredBy: one(user, {
      fields: [collaborationAsset.registeredBy],
      references: [user.id],
    }),
  }),
);

export const collaborationSnapshotRelations = relations(
  collaborationSnapshot,
  ({ one }) => ({
    room: one(collaborationRoom, {
      fields: [collaborationSnapshot.roomId],
      references: [collaborationRoom.roomId],
    }),
    updatedBy: one(user, {
      fields: [collaborationSnapshot.updatedBy],
      references: [user.id],
    }),
  }),
);

export const collaborationRoomMemberRelations = relations(
  collaborationRoomMember,
  ({ one }) => ({
    room: one(collaborationRoom, {
      fields: [collaborationRoomMember.roomId],
      references: [collaborationRoom.roomId],
    }),
    user: one(user, {
      fields: [collaborationRoomMember.userId],
      references: [user.id],
    }),
  }),
);

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

export const sharedSceneRelations = relations(sharedScene, ({ one, many }) => ({
  owner: one(user, {
    fields: [sharedScene.ownerId],
    references: [user.id],
  }),
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
  adminGrant,
  adminAuditEvent,
  personalLibrary,
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
  collaborationRoom,
  collaborationRoomMember,
  collaborationSnapshot,
  collaborationAsset,
  collaborationOperation,
  collaborationCreationFence,
  collaborationLifecycleSubject,
  collaborationLifecycleRegistration,
  collaborationProjectionTombstone,
};
