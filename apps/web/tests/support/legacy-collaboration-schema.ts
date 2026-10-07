/** Protocol-5 fixture derived from c6f2044, calibrated against production on 2026-10-07. */
import {
  pgTableCreator,
  varchar,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  check,
  foreignKey,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user, scene } from "@/server/db/schema";
import {
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ASSET_URL_LENGTH,
} from "@drawstuff/collaboration/asset";
import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
const createTable = pgTableCreator((name) => `drawstuff_${name}`);
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});
export const collaborationRoom = createTable(
  "collaboration_room",
  {
    // relay 用的 room id（nanoid），同時是主鍵：不另外維護第二組識別碼。
    roomId: varchar("room_id", { length: 64 }).notNull(),
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
    primaryKey({
      name: "excalidraw-ericts_collaboration_room_pkey",
      columns: [table.roomId],
    }),
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
      .notNull()
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
    primaryKey({
      name: "excalidraw-ericts_collaboration_room_member_pkey",
      columns: [table.id],
    }),
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

export const ROOM_CONTROL_FAILURES = [
  /** Provider 連不上（DNS、連線拒絕等網路層錯誤）。 */
  "unreachable",
  /** Provider 在 timeout 內沒有回應；delivery 結果 ambiguous，可重送。 */
  "timeout",
  /** Provider 回了非 2xx：請求被拒絕或 provider 自身失敗。 */
  "rejected",
  /** 2xx 但 body 不符合 contract：對方版本不被這個 caller 理解。 */
  "malformed-response",
  /** Durable Object gateway URL 沒有設定。 */
  "unconfigured",
  /** Production 的停用 dispatch 狀態；回滾仍須接受舊 web 寫入。 */
  "dispatch-disabled",
] as const;
export type RoomControlFailure = (typeof ROOM_CONTROL_FAILURES)[number];

/**
 * Durable control outbox：room mutation 與它的 enforcement intent 在同一個
 * transaction 內落地，commit 後由同步 dispatch 與分鐘級 cron drainer
 * idempotently 送到 Durable Object gateway。
 * 只保存最小、非 secret 的 immutable intent——**不保存已簽 token**，每次
 * delivery 都簽 fresh short-lived control token。這是長期 correctness
 * mechanism，不隨 cutover 後的 cleanup 移除。
 *
 * 刻意沒有 room FK：帳號退場會 cascade 刪掉 room row，而它的 end-room
 * enforcement intent 必須活得比 row 久，才能把已連上的 socket 關掉。
 */
export const collaborationControlOutbox = createTable(
  "collaboration_control_outbox",
  {
    eventId: uuid("event_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: varchar("room_id", { length: 64 }).notNull(),
    authGeneration: integer("auth_generation").notNull(),
    /** 這次 mutation 產生的 revision；provider 端以 revision max idempotent。 */
    authRevision: integer("auth_revision").notNull(),
    action: varchar("action", { length: 16 })
      .$type<"revoke-member" | "end-room">()
      .notNull(),
    /** `revoke-member` 的對象；`end-room` 沒有 subject。 */
    subjectUserId: text("subject_user_id"),
    attempts: integer("attempts")
      .notNull()
      .$defaultFn(() => 0),
    nextAttemptAt: timestamp("next_attempt_at").notNull(),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "delivered" | "failed">()
      .notNull()
      .$defaultFn(() => "pending"),
    lastFailure: varchar("last_failure", {
      length: 32,
    }).$type<RoomControlFailure>(),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Drain 熱查詢：status='pending' AND next_attempt_at <= now ORDER BY
    // next_attempt_at，與 deferred_cleanup 的複合索引同一個理由。
    index("collaboration_control_outbox_due_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    check(
      "collaboration_control_outbox_action_supported",
      sql`${table.action} in ('revoke-member', 'end-room')`,
    ),
    check(
      "collaboration_control_outbox_status_supported",
      sql`${table.status} in ('pending', 'delivered', 'failed')`,
    ),
    // Intent 必須完整才進得來：revoke-member 少了對象就無法 enforcement。
    check(
      "collaboration_control_outbox_subject_present",
      sql`${table.action} <> 'revoke-member' or ${table.subjectUserId} is not null`,
    ),
    check(
      "collaboration_control_outbox_last_failure_supported",
      sql`${table.lastFailure} is null or ${table.lastFailure} in (${sql.raw(
        ROOM_CONTROL_FAILURES.map((value) => `'${value}'`).join(", "),
      )})`,
    ),
    check(
      "collaboration_control_outbox_attempts_nonnegative",
      sql`${table.attempts} >= 0`,
    ),
    check(
      "collaboration_control_outbox_auth_generation_positive",
      sql`${table.authGeneration} >= 1`,
    ),
    check(
      "collaboration_control_outbox_auth_revision_positive",
      sql`${table.authRevision} >= 1`,
    ),
  ],
);

// 定義表格關聯
