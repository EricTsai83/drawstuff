# Plan 16：建立 collaboration asset identity

- Status: Completed（2026-08-05，見文末 Verification notes）
- Depends on: Plan 15
- Expected change size: final metadata schema、bounded backfill、read/write API 與
  collision tests

## Outcome

圖片等 Excalidraw binary files 有明確、不可變的 `excalidraw_file_id` identity，
不再以 filename 或 content hash 充當唯一身份。

## In scope

- 定義 room/scene scoped asset metadata。
- Identity 使用 parent scope + `excalidraw_file_id`。
- Content hash 僅作 lookup/deduplication hint，不作 file identity。
- 執行 collision、missing ID、duplicate content 報告。
- 只修改 Drizzle `schema.ts`，用分階段 `pnpm db:push` 處理既有資料；不得建立
  migration proposal/file/SQL。
- 移除以 `name` 或 `(parent, content_hash)` 當 identity 的舊 constraints、queries
  和 retry path；`ut_file_key` 是 storage object identity，不能取代 Excalidraw ID。
- 建立 metadata API；尚不傳輸 file bytes。

## Out of scope

- Asset upload/download。
- Client-side asset encryption。

## Steps

1. 對照 ADR 0001 asset boundary 和現有 `file_record`。
2. 以 ownership、retention、query pattern 和 cascade boundary 決定共用既有 table
   或獨立 relation；ADR 記錄選擇，避免 nullable-polymorphic table 無限擴張。
3. 在 database clone 執行 read-only collision/reference report，並對核心 lookup
   保存 `EXPLAIN`/index evidence。
4. 若有既有 rows，先把 `excalidraw_file_id` 以 nullable schema push 到 clone，
   執行支援 dry-run/batch/checkpoint/idempotency 的 backfill，再 audit zero missing/
   collision；接著 push final not-null/unique/index schema。
5. 在 restore-tested backup 後，以相同 bounded 流程對目標 DB 執行兩次
   `pnpm db:push` 與 backfill；任何 destructive prompt 或無法表達的 DDL 都停止並
   先詢問使用者，不改用 migration file。
6. 切換所有 reads/writes 後刪除 name/content-hash identity、過渡 dual-read/write、
   backfill-only script 與 obsolete indexes。
7. 對 identical bytes/different file IDs、retry、concurrent insert 和 parent
   cascade 建立 integration tests。

## Verification

```sh
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm lint
```

另需保存 clone/target 的 schema diff、DB push output、before/after counts、
backfill checkpoint、query plan 與 restore drill 結果。

## Done when

- 每個 collaboration asset 都可用 parent + Excalidraw file ID 唯一定位。
- 相同 content hash 的不同 file IDs 不會互相覆寫。
- Schema promotion 前的 production-like data report 已通過。
- Final schema 不保留過渡 nullable、舊 identity index 或 dual path；repo 沒有
  migration/backfill artifact，rollback 依靠已驗證的 DB snapshot/restore。

## Verification notes（2026-08-05）

### 根因

舊身份 `(scene_id, content_hash)` 的 hash 取自**壓縮後的上傳 payload**，而
`file-processor.ts` 會把 `created`／`lastRetrieved: Date.now()` 寫進 payload
metadata。於是每次存檔都算出前所未見的 hash、內容去重永不命中，同一張圖每存一次
就多一列 `file_record` 與一個孤兒 storage object。329 列裡只有 67 個真實資產。

### Relation 決策

Room asset 使用獨立 relation `collaboration_asset`，不在 `file_record` 增加第三個
nullable parent。理由（parent／writer／加密／retention／cascade 五項差異）記錄於
[`ADR 0001`](../docs/adr/0001-excalidraw-persistence-boundary.md) 的
「Asset relation boundary」。

### Read-only audit 與 schema 演進

| 項目          | 結果                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before counts | 329 列（owned 329／shared 0）；67 個 distinct identity；29 個重複群組共 291 列；`content_hash` 329 個全不同                                                                       |
| 資料健康度    | `name` 全部符合 Excalidraw file id 形狀（40 hex）；scene 外鍵孤兒 0；`owner_id` null 0                                                                                            |
| Phase 1 push  | `pnpm db:push` 新增 nullable `excalidraw_file_id`（非破壞性，無 prompt）                                                                                                          |
| Phase 2 push  | `drizzle-kit push --force`：not-null + `(parent, excalidraw_file_id)` unique、shape check、刪除 `name` 與三個舊 identity index、建立 `collaboration_asset`                        |
| Query plan    | Before：`Seq Scan`。After：identity lookup 走 `Index Scan using file_record_scene_excalidraw_file_id_unique`；scene manifest 走同一索引前綴的 `Bitmap Index Scan`（不需額外索引） |

### Backfill 執行（script 已刪除）

以 `apps/web/scripts/backfill-collaboration-asset-identity.ts`（三段式
`--inspect` → `--validate` → `--execute`，需
`DRAWSTUFF_ASSET_IDENTITY_BACKFILL_CONFIRM` 與 manifest checksum）在 production
執行後刪除，執行副本存於 `~/drawstuff-backups/plan16-backfill-script-as-executed.ts`。

| 項目          | 結果                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest      | `91a1c6b7ff72ec33ee1cb3fbca7fb81815d86e13469bbb393b2dfa84cbe8482d`                                                                                              |
| Row backup    | `~/drawstuff-backups/plan16-file-record-before-2026-08-05T05-19-58-217Z.json`（全表 329 列）                                                                    |
| Restore drill | 備份還原至臨時表 329 列，與 live 表雙向 `EXCEPT` 差異皆為 0，演練後刪表                                                                                         |
| Execute       | `filled: 67`、`deleted: 262`、`enqueuedForStorageCleanup: 262`（batch 100、逐 batch checkpoint）                                                                |
| After counts  | 67 列／67 identity；待填 0；重複 0                                                                                                                              |
| Idempotency   | 同 manifest 重跑回報 `nothing left to apply`；未設 confirm env 時拒絕執行；table drift 會被 manifest 比對擋下                                                   |
| 孤兒 storage  | 262 個 `ut_file_key` 以 reason `plan16-duplicate-asset-identity` 寫入 `deferred_file_cleanup`（pending），交由既有 `/api/maintenance/cleanup` worker 帶重試刪除 |

### 清理

`name` 欄位、`file_record_scene_content_hash_unique`、
`file_record_shared_scene_name_unique`、`file_record_scene_ut_key_unique`、
`getFileRecordBySceneAndContentHash` 與已無使用者的 `FILE_UPLOAD_MAX_COUNT` 全部
刪除；`content_hash` 降為無唯一性、不參與判斷的 storage 提示。上傳身份改由 input
顯式帶入，檔名不再承載身份（`rg` 確認 `apps/web/src` 已無 file-record `name` 讀取）。

### Review 修正（Codex GPT-5.6 Sol pass 1）

去重移除了一層**意外**的保護：舊 identity 下兩個併發存檔會因 content hash 不同各自
建立一列，於是失敗方回滾只刪自己那列。identity 唯一化之後，失敗方回滾可能刪掉
「已提交場景唯一的一份紀錄與 object」。

修正方式是把保留權威交給已提交文件，而不是與 revision 協調：新增
`apps/web/src/server/scene/referenced-assets.ts`，內含
`readReferencedSceneAssetIds`（回傳 live image 元素引用的 file ids；文件無法解析時
回傳 `null`，與「沒有引用」刻意區分）與純函式 `planSceneAssetCleanup`（無紀錄的 key
可刪、仍被引用的紀錄保留、文件無法解析時全部保留）。
`cleanupSceneAssetUploadsAction` 改為只刪 `deletableKeys` 的紀錄**與** object（先前
無論紀錄是否被刪都會刪 object）。`scene.ts` 的私有
`getReferencedPublishedFileIds` 一併收斂到同一個 helper。
`apps/web/tests/scene-asset-cleanup-retention.test.ts`（14 tests）涵蓋兩個 helper 與
真實 server action 對 PGlite 的併發情境；把 action 還原成舊行為會失敗 3 個。

### 殘留風險：清理與「進行中」存檔的競態（owner：Plan 23）

Pass 2 指出並經確認的殘留視窗：若存檔 A 因**非「B 已提交」**的原因失敗（網路錯誤，
或由第三個不含該圖的存檔造成的 conflict），而 B 已上傳同一個 file id 但尚未提交，
A 的清理會刪掉該資產，B 隨後提交的文件就引用不到位元組。

- 已修正的部分是主要成因：conflict 由 B 自己的提交造成時，已提交文件會保護該資產。
- 影響邊界：僅該場景該張新圖；讀取路徑遇到缺紀錄只是不渲染，重新加入並存檔即可復原。
- 不在 Plan 16 修正：可行方案要改動 owned-scene 存檔語意（新增「資產缺失」失敗
  模式）與客戶端重試流程，屬 [Plan 23](./23-owned-scene-asset-lifecycle.md)。
- 前置稽核已完成（2026-08-05，以生產環境的 `readReferencedSceneAssetIds` 解碼）：
  39 個有資料場景全部可解析、14 個含圖片、56 個被引用 file id、**dangling
  reference 0**、未被引用的紀錄 11 筆。dangling 為 0 表示加上存檔驗證不會讓任何
  既有場景變成無法存檔；11 筆未被引用的紀錄目前沒有任何機制回收，同樣由 Plan 23
  處理。

### Checks

`pnpm typecheck`（4/4）、`pnpm lint`（0 errors，5 個 adapter 既有 warnings）、
`pnpm test`（657 passed：web 228、collaboration 250、adapter 106、relay 73）、
`pnpm knip`（4/4）。`pnpm format:check` 的 15 個 warning 於本次變更前即存在，本次
新增與修改的檔案全部符合 Prettier。

### 接受的偏離

- **未建立 production-like clone**：無 Neon API key、無 `pg_dump`、Docker daemon
  未執行。改以「全表 JSON 備份 + 還原演練（雙向 `EXCEPT` 差異 0）+ `--validate`
  逐列證明只有 `name` → `excalidraw_file_id` 的搬移與去重保留最新列」取代，理由
  同 Plan 21／22：影響範圍為單表 329 列。經使用者明確同意。
- **Phase 2 使用 `--force`**：drop `name` 會產生資料遺失警告。`name` 的值已完整
  複製到 `excalidraw_file_id` 並逐列驗證，且全表備份可還原。經使用者明確同意。
- **Metadata API 尚無 client caller**：`collaborationAsset.list`／`register` 由
  Plan 17 接上傳輸流程時才會被呼叫。本 plan 不加 client 端註冊，避免在
  `onChange` 路徑增加無使用者的網路呼叫。
