# Plan 28：Room-scoped retention

- Status: Completed（2026-08-06，見文末 Verification notes）
- Depends on: 19、23（step 4）
- Expected change size: 一個有界可重跑的回收 job、稽核與 before/after counts

> 2026-08-06 由 Plan 19 step 5 拆出。它是 Plan 15／17 的共同缺口，於 2026-08-05 的 Plan 17
> review 期間確認。

## 為什麼曾被阻擋（已解除：Plan 23 step 4 於 2026-08-06 完成）

Asset 物件必須沿用 `deferred_file_cleanup`（刪列與入列同一交易），而那個佇列住在
`/api/maintenance/cleanup`。該 endpoint 目前把六件互不相關的工作放在**同一個 `try` 區塊**，
第一件是「刪除所有非擁有者使用者」——任何前面的工作拋錯，後面全部不執行。本 plan 的回收
job 正要住進那裡，因此必須先完成 [Plan 23 step 4](./23-owned-scene-asset-lifecycle.md) 的
endpoint 拆分（具名 job、逐 job try/catch、POST-only、advisory lock、佇列處理排最後）。

Plan 23 自己的背景註記記錄了同一件事：2026-08-05 手動清理 262 筆孤兒 storage key 時，正因
為這個連坐問題而無法使用該 endpoint，改以一次性腳本完成。

## Outcome

結束或過期的 room 不會無限期留下 snapshot 密文（Postgres）或 asset 物件（object storage），
且回收是有界、可重跑、有 before/after counts 的。

## In scope

- **問題界定**：`collaboration_snapshot` 與 `collaboration_asset` 目前只在**世代轉動**時
  退休舊世代；`collaborationRoom.end` 只把 `status` 設為 `ended`，過期只是 `expiresAt`
  比對。production 沒有任何路徑刪除 room 列。單一 room 世代是有界的（1 個 snapshot、最多
  `MAX_ROOM_ASSETS_PER_GENERATION` 個資產），但**跨 room 隨時間無界**，而 room TTL 預設
  12 小時、上限 24 小時，代表累積速度等於開房速度。
- **回收觸發與界限**：決定 room `ended`／`expiresAt` 之後多久回收、單次上限、如何重跑。
- **實作**：snapshot 直接刪列；asset 物件走 `deferred_file_cleanup`（刪列與入列同一交易），
  以 Plan 23 拆分後的具名 job 形式加入，失敗只影響自己這個 job。
- **稽核先行**：啟用前先對既有資料做 read-only 稽核，並保存 before/after counts。

## Out of scope

- Owned-scene 的資產生命週期（Plan 23）。
- 改變 room TTL 的預設或上限。
- 立即刪除：回收必須有寬限期，否則一個誤判的過期就會毀掉還在用的 room。

## Steps

1. 等 Plan 23 step 4 完成。
2. 稽核既有資料：多少 ended／expired room 仍留有 snapshot 與 asset，各佔多少空間。
3. 決定寬限期、單次上限與重跑方式。
4. 以具名 job 實作回收，snapshot 刪列、asset 入列 `deferred_file_cleanup`。
5. 對既有積壓執行一次，保存 before/after counts。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需保存回收前後的 counts，以及「回收不會動到仍在存活期的 room」的測試。

## Done when

- 結束或過期的 room 不會無限期留下 snapshot 密文或 asset 物件。
- 回收有界、可重跑，且有 before/after counts。
- 仍在存活期的 room 不會被回收，且有測試守住。
- 單一 job 失敗不影響 maintenance endpoint 的其他 job。

## Verification notes（2026-08-06）

### 設計決策（step 3）

- **寬限期**：預設 7 天。`ended` 以 `coalesce(ended_at, updated_at)` 起算，過期但仍
  `active` 的以 `expires_at` 起算。Room TTL 上限 24 小時，7 天足以排除「還在用的
  room」；每週 cron 下實際回收在結束後 7–14 天。
- **單次上限**：`maxRooms`（預設 50）＋ `maxAssetObjects`（預設 400，低於 drain 的
  `maxTasks: 500`，保留其他 job 入列的 headroom；review pass 1 finding）。room 整室
  處理；單一 room 超出物件預算時，允許它作為該次的第一個 room 處理（單室由 schema 的
  每世代 512 上限界定），其後的 room 遞延並回報 `truncated`。
- **重跑方式**：候選只包含「仍持有 snapshot／asset 列」的 ended／expired room，掃完
  即空，重跑冪等；`truncated` 表示還有剩，下次 cron 或手動 POST 接續。
- **過期但仍 `active` 的 room 在回收交易內先標為 `ended`**：`create` mutation 會
  refresh 過期的 active room（同一個 roomId 復活），不先關閉就可能出現「回收後復活、
  但 baseline 與資產已消失」。不 bump `authRevision`、不推 relay control——token 內含
  room expiry（`rexp`），所有 session 與 token 早在多日前失效。Room 列本身保留為歷史。
- **資格在 room lock 下重查**：候選查詢與上鎖之間 owner 可能 refresh 了 room。

### 稽核與執行（steps 2、5）

以 `apps/web/scripts/audit-collaboration-room-retention.ts`（唯讀）對唯一 Neon DB：

- **前**：room 共 1 個（過期仍 active），snapshot／asset 列皆 0；
  `endedOrExpiredHoldingData: 0`、`reclaimablePastGrace: 0`——既有積壓為 0。
- 以 `createRoomRetentionJob()`（與 endpoint 相同的 job 程式）執行：
  `roomsReclaimed: 0`，立即重跑亦 0（冪等）。該 room 不持有資料，不在回收對象內，
  維持現狀。
- **後**：與前相同（0 積壓）。真正的收益是防止未來累積：job 已進
  `routineMaintenanceJobs()`，排在 drain 之前。

### Review（Codex GPT-5.6 Sol）

Pass 1 回傳 1 個 finding，接受並修正：

1. **回收入列可能超過同次 drain 的處理容量**（P2）：單室最多 512 個 asset，
   50 室上限下一次可入列遠超 drain `maxTasks: 500`，物件會滯留數週的週跑 cron——
   正是 Plan 23 修過的「排空速度與 cron 頻率不匹配」。修正：加入
   `maxAssetObjects`（預設 400）物件預算，交易內先數該室 asset 數，整室處理、
   首室可獨佔超額（避免永久飢餓）、其後遞延並回報 `truncated`；補測試。

Pass 2（修正後的最終 pass）：確認 pass 1 修正正確（整室原子回收與首室超額行為），另回傳
1 個 finding，接受並以最小修正處理（已達兩-pass 上限，此修正未再送 review）：

2. **物件預算未涵蓋所有 producer**（P2）：同一次 routine run 中 GC 可自行入列 500、
   sharedScene 失敗也會入列，聚合可達 900+，超過 drain 預設 `maxTasks: 500`。修正：
   `routineMaintenanceJobs()` 的 drain 調為 `maxTasks: 1000`（producer 聚合上限＋
   headroom），wall-clock 預算仍為實際約束、`remaining` 照樣回報；補「GC 與
   retention 同次入列、drain 當次全清」組合測試。

### Checks

`pnpm --filter @drawstuff/web typecheck`（通過）、`pnpm --filter @drawstuff/web test`
（29 files / 369 tests 通過，含新增 collab room retention 6 例：ended 室回收＋同次
drain＋冪等、存活期／剛結束／剛過期不動、過期 active 先轉 ended、室數上限截斷、
物件預算遞延、GC＋retention 同次 routine run 組合）、`pnpm lint`（0 errors；adapter
5 個既有 warnings）。另生產 DB 驗證出 postgres-js 對 raw sql 內插 Date 參數的序列化
限制（PGlite 不會抓到），已改為欄位型別比較。

## 追加：剩餘風險收斂（2026-08-06，第二輪 review cycle）

首輪報告列出的三項剩餘風險均無其他 plan 涵蓋（Plan 25／29 的「drain」是 relay 連線
drain，非 cleanup 佇列），同日在本 plan 內收掉：

1. **Drain 的 task 上限被 60 秒 wall-clock 架空**：route 加 `export const maxDuration
   = 300`，routine drain 調為 `budgetMs: 180_000`。
2. **空的過期 active room 永遠殘留（且可被 create 復活）**：過期超過寬限的 room 即使
   不持有資料也成為候選並轉 `ended`；ended room 仍只在持有資料時成為候選（掃完即出，
   冪等不變）。`roomsReclaimed` 只計有資料的室，轉態計入 `endedExpiredRooms`。
3. **未經 review 的 pass 2 修正**：本輪 review 對完整 diff 重新驗證，一併覆蓋。

生產 DB 驗證：現存唯一 room（過期 active、無資料）**尚未過 7 天寬限**，job 兩次執行
均正確不動它（寬限防護在真實資料上驗證）；過寬限後由每週 cron 轉 `ended`。

本輪 review（Codex GPT-5.6 Sol，pass 1 回傳 2 個 findings）：

1. **drain 上限未涵蓋真實有界上限**（P2，部分接受）：GC 500＋retention 首室超額 512
   ＝1,012 > 1,000。調為 `maxTasks: 1200` 並在註解記推導；1,012 列的邊界整合測試
   拒絕（上限語意已有測試，常數推導已記錄）。
2. **route 無整體 deadline**（P2，部分接受）：drain 前的工作無時間上界時，drain 拿
   全新 180 秒可把 route 推過 300 秒。修正：`QueueDrainOptions.deadlineAt`（絕對截止，
   與 `budgetMs` 取較早者、逐 task 檢查），route 於 handler 開始算出
   `now + 300s − 60s margin` 傳入 GET／POST 兩路徑；補 deadline 測試。**Pre-drain
   工作本身無上界（expired-shared-scenes、user purge）為既有行為，超出本 plan 範圍，
   未處理**（見剩餘風險）。

Pass 2（最終 pass）：無 findings，確認 1,200 上限涵蓋 1,012、deadline 計算與佈線
正確、無回歸。

Checks（第二輪後）：typecheck 通過、test 29 files / 371 tests 通過（新增「空過期室
轉 ended」與「絕對 deadline」2 例）、lint 0 errors。

剩餘（不在本 plan 處理）：pre-drain 各 job 自身的執行時間無上界屬 Plan 23 之前的
既有行為；佇列為 durable outbox，route 即使被平台終止也不丟資料，只少一份報告。
