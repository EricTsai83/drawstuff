# 03 — 後端 API 效能與強健性

來源：2026-08-13 全面 code review（web 後端）。storage 生命週期問題已完成，
現況見 [docs/architecture/data-lifecycle.md](../docs/architecture/data-lifecycle.md)。

## 效能

### H2（HIGH）`getUserScenesInfinite` 回傳每筆完整 `sceneData`

- `apps/web/src/server/api/routers/scene.ts:171`（output）、`:303`（mapping）
- `sceneData` 上限 `SCENE_DATA_MAX_LENGTH = 5 MiB`（`lib/schemas/scene.ts:6`），
  `limit` 可到 100（`scene.ts:146`）→ 最壞單頁 ~50 MB superjson + RSC hydration 再一份。
- 修法：從列表 output 拿掉 `sceneData`；唯一 consumer `components/scene-card.tsx:196`
  已有 lazy `getScene.fetch` fallback（`:199`）。

### H3（HIGH）`expiredSharedScenesJob` 是唯一無界的 maintenance job

- `apps/web/src/server/maintenance/jobs.ts:118-143`
- 一次抓全部過期 shared-scene id（`queries.ts:273`）、單一 `inArray` 抓全部 file record
  （`queries.ts:282`）、逐檔序列刪 storage、無 deadline 檢查；且排在
  `routineMaintenanceJobs` 第一位（`jobs.ts:731`），積壓時吃光 300s route 預算
  （`app/api/maintenance/cleanup/route.ts:38`）餓死其他 job。
- 修法：加 `maxSharedScenes`/`maxObjects` 與 `deadlineAt`（比照其他 job）；`inArray` 分塊。

### M1（MEDIUM）Dashboard keyset pagination 缺複合索引

- `apps/web/src/server/db/schema.ts:337-343` vs 查詢 `scene.ts:257-263`
- 查詢：`userId = ? AND sceneData IS NOT NULL AND isArchived = ?`、
  order by `(updatedAt DESC, id DESC)`。現有索引皆不合用；cursor 條件（`scene.ts:246-255`）
  無法走 index range → 第 n 頁與第 1 頁同價。
- 修法：`index("scene_user_updated_idx").on(userId, desc(updatedAt), desc(id))`。
  順帶評估移除 `scene_last_updated_idx`（沒有查詢以 `last_updated` 排序）與
  `scene_name_idx`（leading-wildcard `ilike`（`scene.ts:215`）用不到）。

### M13（MEDIUM）`deferred_file_cleanup` drain 熱查詢缺複合索引

- `schema.ts:820-824` vs `queries.ts:158-170`
- 查詢 `status='pending' AND next_attempt_at <= now ORDER BY next_attempt_at`，現為兩個
  單欄索引 → 每次 drain 最多 24 批都做 bitmap-AND + sort。
- 修法：改為 `(status, next_attempt_at)` 複合索引。

### M8（MEDIUM）`listRoomMembers` 無界且回傳 revoked members

- `apps/web/src/server/collab/rooms.ts:224-238`（caller `collaboration-room.ts:254`）
- `linkRole: "editor"` 房間每個 joiner 都建 membership row
  （`ensureRoomMembership`, `collaboration-room.ts:398`）；廣傳連結累積數千 row 後，
  panel 輪詢的 `collaborationRoom.get` 每次全撈全序列化。
- 修法：分頁或至少加 cap；revoked rows 改為 explicit flag 才回傳。

### M9（MEDIUM）GC job 把所有候選 scene id 讀進記憶體再洗牌

- `jobs.ts:216` → `queries.ts:120`、shuffle `jobs.ts:525`
- 無界 `SELECT DISTINCT scene_id FROM file_record` + 全陣列 Fisher-Yates，只取前 200。
- 修法：SQL 端 `ORDER BY random() LIMIT maxScenes`，或持久化 cursor。

### L10 `getActiveForScene` 多一次 room lookup

- `collaboration-room.ts:337` 之後 `resolveRoomAccess`（`rooms.ts:85`）重讀同一 row。
- 修法：`resolveRoomAccess` 接受 pre-read room record。

## 強健性

### M6（MEDIUM）`syncSceneCategories` 插入 category 無 conflict 處理

- `apps/web/src/server/scene/save-owned-scene.ts:439-442`；unique index `schema.ts:296`
- 同使用者兩個並發 save 引入同名新分類 → 23505 → 整個 save transaction rollback 成
  `INTERNAL_SERVER_ERROR`，使用者丟失存檔。`category.ts:58` 已有正確處理可參照。
- 修法：`.onConflictDoNothing({ target: [category.userId, category.name] })` 後重查 id。

### M7（MEDIUM）`collaborationRoom.create` 靜默重設既有房間的 `linkRole`

- `collaboration-room.ts:191`；`input.linkRole` 預設 `"none"`（`:150`），client 唯一
  call site 無條件傳 `"none"`（`collaboration-room-dialog.tsx:387`）。
- 房主設好 link-editor 後再觸發「開始共編」→ 房間靜默退回 invite-only，link 參與者
  下次 join 被拒且無錯誤顯示。
- 修法：`create` 的 `linkRole` 改 optional，只在 insert 路徑套用，refresh 路徑不動。

### M12（MEDIUM）shared-scene 建立無 rate limit、無 per-user 配額

- `apps/web/src/server/actions.ts:34-91`
- 每次呼叫最多寫 5 MiB `bytea`，只要有登入 session；row 存活 30 天（`jobs.ts:121`）。
- 修法：加 per-user limiter（`rate-limit/collaboration.ts` 的機制可泛化）。

### M11（MEDIUM）`db/index.ts`、`db/schema.ts` 缺 `server-only` guard

- `server/db/index.ts:1`、`server/db/schema.ts:1`；13 個 leaf module 已用 `server-only`，
  但兩個基礎 module 沒有。`db/index.ts:15` 在 module scope 開 live 連線。目前邊界乾淨
  但只靠慣例維持。
- 修法：兩檔各加一行 `import "server-only";`。

### M10（MEDIUM）三個 router 各抄一份 `accessError`

- `collaboration-room.ts:67-87`、`collaboration-snapshot.ts:63-83`、
  `collaboration-asset.ts:38-58`；`roomIdInput` 亦重複（另見 `admin.ts:324`、`core.ts:273`）。
- 修法：從 `@/server/collab/rooms`（或新 `collab/errors.ts`）export 共用。

## Low（順帶修）

- L1：`setMemberRole`/`removeMember` 對不存在的 userId 回 FK violation 而非 `NOT_FOUND`
  （`collaboration-room.ts:496,560`）。
- L2：公開的 `sharedScene.getFileRecordsBySharedSceneId` 洩漏 `utFileKey`
  （`shared-scene.ts:20-41`）— client 只用 `url`。
- L3：`sharedScene` 兩個 public procedure 的 id 無 `.max()`、無 IP limiter
  （`shared-scene.ts:9,21`）。
- L4：`workspace.delete` 5 個序列 statement 無 transaction（`workspace.ts:277-338`）
  — 併入 plan 02 的 H1 一起改。
- L6：`completeAdminAudit` 失敗會蓋掉原始錯誤（`admin.ts:50-56`）。
- L7：`admin.access` 的 `userId` input 是純儀式（`admin.ts:64-69`）。
- L8：`z.string().uuid()` 與 `z.uuid()` 混用，統一其一。
- L9：`lib/base-url.ts:1` import `@/env` 進 client graph；改讀
  `process.env.NEXT_PUBLIC_BASE_URL`，讓 `env.ts` 未來可加 `server-only`。

## 驗證

- H2/M1：dashboard 首屏 payload 與查詢計畫前後對比（`EXPLAIN ANALYZE`）。
- H3：模擬積壓（大量過期 shared scene）跑 maintenance route，斷言其他 job 仍執行。
- M6：並發 save 同名新分類的測試。
- 索引變更走 `pnpm db:push` 流程。
- Repo-level：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。
