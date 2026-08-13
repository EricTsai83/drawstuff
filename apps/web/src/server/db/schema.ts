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
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ASSET_URL_LENGTH,
} from "@drawstuff/collaboration/asset";
import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
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
 * 共編 room。一個 room 綁定一個 scene，room 的授權由這裡決定，relay
 * 只驗證由本表簽出的短效 join token。
 *
 * `authGeneration` 是「授權世代」，與 relay 在記憶體中發放的 session epoch
 * （`roomGeneration`）不同：授權世代寫在 DB、只在需要讓既有 token 全部失效時
 * 遞增；room key 也綁在同一個世代上。移除成員只會阻止新連線
 * 與新訊息；要做密碼學撤銷必須遞增世代。
 */
export const collaborationRoom = createTable(
  "collaboration_room",
  {
    // relay 用的 room id（nanoid），同時是主鍵：不另外維護第二組識別碼。
    roomId: varchar("room_id", { length: 64 }).primaryKey(),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => scene.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    authGeneration: integer("auth_generation").default(1).notNull(),
    /**
     * 單調遞增的授權版本：每次成員／生命週期變更都在 row lock 下 +1。cutoff 用
     * 版本而不是時間排序，等鎖的請求才不會發出比自己還舊的 cutoff，重新授權後
     * 簽出的 token 也一定高於該次 cutoff。
     */
    authRevision: integer("auth_revision").default(1).notNull(),
    /**
     * 拿到連結但沒有 member row 的已登入使用者取得的角色；預設 `none`
     * （invite-only）。匿名加入一律不支援：所有 room API 都要求登入 session。
     */
    linkRole: varchar("link_role", { length: 16 }).default("none").notNull(),
    /**
     * 金鑰檢查值：room 建立與 generation rotate 後，由 owner 的
     * client 用 purpose `keycheck` 的推導金鑰封裝一段固定明文寫入。client 在
     * join 之前驗證，開不了即視同錯誤連結，因此錯誤金鑰不可能建立或覆寫
     * snapshot。伺服器只保存密文，沒有金鑰也沒有驗證路徑；AAD 綁 room id 與
     * authGeneration，跨 room／跨世代搬運無效。null 代表 owner 尚未（或未能）
     * 寫入——client 端視為無法驗證而拒絕加入；rotate 會先清空再由 owner 重算。
     */
    keyCheck: bytea("key_check"),
    status: varchar("status", { length: 16 }).default("active").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
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
    // 「這個 scene 現在有沒有 active room」與生命週期清理都走這兩個索引。
    index("collaboration_room_status_expires_at_idx").on(
      table.status,
      table.expiresAt,
    ),
    // 同一個 scene 最多一個 active room；ended room 保留為歷史紀錄。
    uniqueIndex("collaboration_room_active_scene_unique")
      .on(table.sceneId)
      .where(sql`status = 'active'`),
    check(
      "collaboration_room_auth_generation_positive",
      sql`${table.authGeneration} >= 1`,
    ),
    check(
      "collaboration_room_auth_revision_positive",
      sql`${table.authRevision} >= 1`,
    ),
    check(
      "collaboration_room_status_supported",
      sql`${table.status} in ('active', 'ended')`,
    ),
    check(
      "collaboration_room_link_role_supported",
      sql`${table.linkRole} in ('none', 'viewer', 'editor')`,
    ),
    // 檢查值是固定明文的密封結果，長度是常數：其他長度一律不是合法 envelope。
    check(
      "collaboration_room_key_check_length",
      sql`${table.keyCheck} is null or octet_length(${table.keyCheck}) = ${sql.raw(
        String(KEYCHECK_CIPHERTEXT_BYTES),
      )}`,
    ),
  ],
);

/**
 * 明確授權的 room 成員。`revokedAt` 不為 null 代表已被移除：保留 row 才能區分
 * 「被移除」與「從未加入」——被移除的人即使有 room 連結也不能重新取得 token。
 */
export const collaborationRoomMember = createTable(
  "collaboration_room_member",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: varchar("room_id", { length: 64 }).notNull(),
    userId: text("user_id").notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    revokedAt: timestamp("revoked_at"),
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
    index("collaboration_room_member_user_id_idx").on(table.userId),
    check(
      "collaboration_room_member_role_supported",
      sql`${table.role} in ('owner', 'editor', 'viewer')`,
    ),
  ],
);

/**
 * 共編 room 的持久化 snapshot。room 的所有 client 離線或 relay restart
 * 之後，後來加入的人就是從這裡取得 baseline。
 *
 * 這一列只存密文：`ciphertext` 是 client 用 room key（purpose `snapshot`）封裝的
 * bytes，伺服器沒有金鑰也沒有解密路徑。伺服器看得到的 metadata 一律與場景內容
 * 無關——crypto 版本、revision、位元長度，以及**密文**的 checksum（對密文取
 * hash，才不會變成驗證猜測明文的工具）。
 *
 * 主鍵是 (room_id, auth_generation)：generation 轉動之後舊密文在密碼學上已經不可
 * 讀，所以新 generation 從「沒有 snapshot」開始才是正確狀態，而不是留著一份永遠
 * 打不開的資料。寫入時會刪掉更舊 generation 的列，保留策略因此有界。
 *
 * 這和 owned-scene V4 save 是兩個互不覆寫的 lifecycle（ADR 0001）：那一份由場景
 * 擁有者按下儲存時寫入 `scene.scene_data`，這一份由 room 內被選出的參與者定期
 * 寫入，兩者永遠不會互相蓋掉。
 */
export const collaborationSnapshot = createTable(
  "collaboration_snapshot",
  {
    roomId: varchar("room_id", { length: 64 }).notNull(),
    authGeneration: integer("auth_generation").notNull(),
    /** 每次成功寫入 +1；conditional write 用它擋掉舊 snapshot 覆寫新 snapshot。 */
    revision: integer("revision").notNull(),
    /** Sealed envelope 版本，對應 `SNAPSHOT_CRYPTO_VERSION`。 */
    cryptoVersion: integer("crypto_version").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    /** 密文長度；和 `octet_length` 的 check 一起把單列大小限制住。 */
    byteLength: integer("byte_length").notNull(),
    /** 密文的 SHA-256 hex：偵測儲存層損壞，不洩漏明文資訊。 */
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
    primaryKey({
      name: "collaboration_snapshot_room_generation_pk",
      columns: [table.roomId, table.authGeneration],
    }),
    check(
      "collaboration_snapshot_revision_positive",
      sql`${table.revision} >= 1`,
    ),
    check(
      "collaboration_snapshot_auth_generation_positive",
      sql`${table.authGeneration} >= 1`,
    ),
    check(
      "collaboration_snapshot_crypto_version_positive",
      sql`${table.cryptoVersion} >= 1`,
    ),
    // 位元長度必須與密文一致，且不得超過 `MAX_SNAPSHOT_CIPHERTEXT_BYTES`：
    // 授權成員也不能靠 snapshot 無界地長大資料庫。
    check(
      "collaboration_snapshot_byte_length_matches",
      sql`${table.byteLength} = octet_length(${table.ciphertext})`,
    ),
    check(
      "collaboration_snapshot_byte_length_bounded",
      sql`${table.byteLength} between 1 and ${sql.raw(
        String(MAX_SNAPSHOT_CIPHERTEXT_BYTES),
      )}`,
    ),
  ],
);

/**
 * 共編 room 的 binary asset：身份與密文所在位置。
 *
 * 一列代表「這個 room 的這個授權世代有這個 Excalidraw file id 的密文，存在這個
 * storage object」。身份是 (room, generation, `excalidraw_file_id`)，
 * `ut_file_key`／`url` 只是「現在存在哪裡」——重新上傳會得到新 key，所以它不是身份，
 * 只能由身份反查出來。
 *
 * 這張表**沒有純身份的列**：一列存在就代表位元組已經上傳完成。原因是可用性只有一種
 * 有意義的答案——peer 從 element 的 `fileId` 知道要哪張圖，需要問的是「位元組在哪、
 * 到了沒」。先寫一列「已註冊但還沒有 bytes」只會讓讀取端無法區分這兩件事。
 *
 * 也刻意沒有 MIME type 與 content hash：兩者都在密文裡（payload metadata），伺服器
 * 看不到也不需要看到。把 MIME 複製到欄位上只會產生一份伺服器無法驗證、卻可能與
 * 密文不一致的斷言。
 *
 * 為什麼不放進 `file_record`：那張表的 parent 是 scene／sharedScene、內容是明文
 * 壓縮後上傳到 UploadThing、retention 跟著 scene 走。Room asset 的 parent 是 room、
 * 內容將由 room key 加密、retention 跟著授權世代走，而 writer 可能是非 scene
 * owner 的 editor。在 `file_record` 加第三個 nullable parent 只會讓
 * nullable-polymorphic table 繼續擴張，四種 lifecycle 混在同一組 constraint 裡
 * （見 ADR 0001 的 asset relation boundary）。
 *
 * 主鍵是 (room_id, auth_generation, excalidraw_file_id)：與
 * `collaboration_snapshot` 同一套 retention 語意——世代轉動後舊世代的密文在密碼學
 * 上已不可讀，所以新世代從空 manifest 開始才是正確狀態；註冊時會清掉更舊世代的
 * 列，保留量因此有界。前綴 (room_id, auth_generation) 直接服務「列出這個世代的
 * manifest」，不需要額外索引。
 *
 * 這裡刻意沒有 content hash：Excalidraw file id 本身就是明文位元組的摘要，再存一份
 * 內容雜湊不會增加 lookup 能力，只會給伺服器一個確認猜測明文的 oracle。
 */
export const collaborationAsset = createTable(
  "collaboration_asset",
  {
    roomId: varchar("room_id", { length: 64 }).notNull(),
    authGeneration: integer("auth_generation").notNull(),
    /** 不可變的 Excalidraw file id；在 (room, generation) 內唯一。 */
    excalidrawFileId: varchar("excalidraw_file_id", { length: 64 }).notNull(),
    /** Sealed envelope 版本，對應 `ASSET_CRYPTO_VERSION`。 */
    cryptoVersion: integer("crypto_version").notNull(),
    /** 密文的 storage object 身份；清理與去重都用它。 */
    utFileKey: varchar("ut_file_key", { length: 256 }).notNull(),
    /**
     * 密文目前的下載位置；不是身份，重新上傳會變。長度與
     * `MAX_ASSET_URL_LENGTH` 同步：transfer contract 拒收的 URL 這裡也存不下。
     */
    url: varchar("url", { length: MAX_ASSET_URL_LENGTH }).notNull(),
    /** 密文長度；下載前的上界檢查，且與 `MAX_ASSET_CIPHERTEXT_BYTES` 一起設限。 */
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
      name: "collaboration_asset_room_generation_file_pk",
      columns: [table.roomId, table.authGeneration, table.excalidrawFileId],
    }),
    check(
      "collaboration_asset_auth_generation_positive",
      sql`${table.authGeneration} >= 1`,
    ),
    check(
      "collaboration_asset_excalidraw_file_id_shape",
      sql`${table.excalidrawFileId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    check(
      "collaboration_asset_crypto_version_positive",
      sql`${table.cryptoVersion} >= 1`,
    ),
    // 授權成員也不能靠 asset 無界地長大 storage：單一資產的密文長度有上界。
    check(
      "collaboration_asset_byte_length_bounded",
      sql`${table.byteLength} between 1 and ${sql.raw(
        String(MAX_ASSET_CIPHERTEXT_BYTES),
      )}`,
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
};
