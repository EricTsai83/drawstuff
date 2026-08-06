# Plan 23：收斂 owned-scene asset lifecycle

- Status: Completed（2026-08-06，見文末 Verification notes）
- Depends on: 16（獨立於 17–20 chain）
- Expected change size: save-time asset validation、cleanup 序列化、unreferenced
  asset GC、upload skip 與 maintenance endpoint 責任拆分

> 背景（2026-08-05）：Plan 16 把資產身份定為 parent scope + `excalidraw_file_id`
> 之後，三個原本被「每次存檔都新增一列重複資料」掩蓋的問題浮出來。三者共用同一組
> 檔案（`use-cloud-upload.ts`、`actions.ts`、`save-owned-scene.ts`、`queries.ts`）
> 與同一份稽核資料，因此收在同一份 plan，而不是散進共編線的 17–20。
>
> Upstream 參考：官方 `excalidraw-app` 把 **storage 物件路徑本身當身份**
> （`ref(storage, "${prefix}/${id}")`），所以重複上傳只是覆寫同一個物件，結構上不可能
> 產生重複；並且 client 端 `FileManager` 以 `savedFiles`（id + version）快取「已存過
> 的檔案」，同一個 session 內不會重複上傳。Drawstuff 因為用 UploadThing（storage key
> 由服務端產生），必須以 DB 列做 file id → storage key 的映射，但**這兩個 upstream
> 性質都值得補上**。
>
> 追加背景（2026-08-05，手動清理 Plan 16 的 262 筆孤兒 storage key 時發現）：
> `/api/maintenance/cleanup` 把六件互不相關的工作放在**同一個 `try` 區塊**，其中第一件
> 是「刪除所有非擁有者使用者」。任何前面的工作拋錯就會讓後面全部不執行，而本 plan 的
> asset GC 正要住進這個 endpoint。當時因此無法用它清理佇列，改寫一次性腳本完成。

## Outcome

Owned scene 的資產生命週期在併發下不會遺失已提交場景引用的資產、不再累積無人引用
的資產列，且存檔只上傳這個場景還沒有的資產。

## In scope

- **關閉「清理 vs 進行中存檔」競態**（Plan 16 review pass 2 確認的殘留風險）：
  - `saveOwnedScene` 在同一交易內驗證「文件引用的每個 `excalidraw_file_id` 都有
    `file_record`」，缺少則以新的明確錯誤碼拒絕存檔，不得靜默提交壞引用。
  - `cleanupSceneAssetUploadsAction` 把「讀已提交文件 → 決定 → 刪紀錄」放進單一
    交易並對 scene row 取 `FOR UPDATE`，與存檔序列化。
  - 客戶端處理新錯誤碼：重新上傳缺少的資產後重試，並保持場景 dirty。
- **Unreferenced asset GC**：回收「場景文件已不引用」的 `file_record` 與其 storage
  物件（2026-08-05 稽核為 11 筆）。GC 必須有界、可重跑，且與上一項的保留規則共用
  同一份「被引用」判斷（`readReferencedSceneAssetIds`），不得產生第二套語意。
- **存檔只上傳缺少的資產**：存檔前先取得該 scene 已有的 file id 集合（或沿用
  Plan 17 引入的 client 端 saved-file 追蹤），只上傳缺少的；移除「上傳 → 伺服器以
  身份衝突拒絕 → 刪除剛上傳的物件」這條每次存檔都會走的往返。
- **拆分 `/api/maintenance/cleanup` 的責任**（設計見下方專節）：讓 asset GC 有一個
  不會被其他工作連坐的位置，並把「刪除所有非擁有者使用者」從週期性維護中移出。
- 評估把 UploadThing `customId` 設為 `${sceneId}:${excalidrawFileId}`，讓 storage
  物件自身帶身份（`deleteFiles`／`getFileUrls`／`generateSignedURL` 都支援
  `keyType: "customId"`）。採用前必須先驗證 UploadThing 是否對 `customId` 強制唯一
  以及重複上傳的行為；不得在未驗證前把它當唯一鍵。

## Out of scope

- 共編 room 資產的傳輸與加密（Plan 17）；room 結束／過期後的 asset 與 snapshot
  retention 屬 Plan 19。但注意 Plan 17 的世代退休**會寫進同一個 `deferred_file_cleanup`
  佇列**（reason `collab-asset-generation-retired`），所以下方的 endpoint 拆分不能假設
  只有 owned-scene GC 使用它。
- Relay／backend 的 limits、metrics 與 load test（Plan 19）。
- 改寫 stored document 或由伺服器產生 file id（違反 ADR 0001 native document
  boundary）。
- 伺服器端驗證 file id 與位元組相符：加密路徑在原理上不可能，已列為 ADR 0001 的
  accepted limitation。

## Maintenance endpoint 拆分設計

### 現況與問題（`apps/web/src/app/api/maintenance/cleanup/route.ts`）

單一 handler 依序做六件事，全部包在同一個 `try` 內：刪除非擁有者使用者及其檔案、
刪除 30 天前的 sharedScene 及其檔案、讀取延遲清理佇列、刪除過期 sessions、刪除過期
verifications、清除 30 天前已完成／失敗的佇列列，最後才處理佇列。具體問題：

1. **共用 `try` = 連坐**：任一步驟拋錯就 `catch` 回 500，後續步驟完全不執行。
2. **最危險的工作排在最前面**：`deleteUsersExceptEmail` 是「刪除除某個 email 以外
   的所有使用者」，blast radius 隨使用者數成長，卻和例行維護綁在同一次呼叫、同一
   個 secret、同一個 cron。它沒有 dry-run、沒有上限，也不回報刪了哪些帳號。
3. **佇列讀取位置錯**：queue 在第 82 行讀取，但第 132 行才處理，中間夾著三件不相關
   的工作。排在讀取之後的新工作（本 plan 的 asset GC 正是如此）其入列結果會被延到
   下一次執行才處理。
4. **`export const GET = POST`**：破壞性操作可用 GET 觸發，註解自稱「方便暫時手動」
   但沒有移除條件，違反 plans 共同規則 7。
5. **佇列排空速度與 cron 頻率不匹配**：每次固定取 50 筆，而 cron 是每週一次；262 筆
   的積壓需要約 6 週。本次是以一次性腳本繞過才清完。
6. **無 single-flight 保護**：手動觸發與 cron 重疊時，兩次呼叫會取到同一批 tasks 並
   各自對同一個 key 呼叫刪除。
7. **回應無法診斷**：只有加總數字；某個步驟失敗時整個回應變成一個字串化的 error。

### 目標設計

- **每個工作是一個具名 job，各自 try/catch，互不連坐。** 抽出
  `apps/web/src/server/maintenance/jobs.ts`，每個 job 是
  `{ name, run(ctx): Promise<JobOutcome> }`；route 只負責授權、選擇要跑哪些 job、
  依序執行並收集結果。單一 job 失敗只讓自己的結果變成
  `{ name, status: "error", error }`，其餘照跑。
- **回應是逐 job 報告**：`{ jobs: JobOutcome[], failed: number }`。全部成功回 200；
  有任何 job 失敗回 500 但**仍附完整報告**——這樣 cron 監控看得到失敗，而成功的
  部分不會被一個字串化 error 蓋掉。
- **把使用者清除移出例行維護。** `deleteUsersExceptEmail` 不是週期性維護，而是
  single-tenant 的資料重置：
  - 移到獨立、預設不執行的 job，需要 `CRON_SECRET` **之外**的第二個明確確認
    （env 或 request body 的 confirmation token），週期 cron 不會觸發它。
  - 必須支援 dry-run：先回報「將要刪除哪些 user id／email 與各自的 scene／asset／
    thumbnail 數量」，確認後才執行。
  - 執行結果逐帳號回報，不只總數。
- **工作順序固定，佇列排空放最後。** 任何會入列的 job（asset GC、使用者清除、
  sharedScene 過期）都排在佇列處理之前，佇列在處理的那一刻才讀取，讓同一次執行入列
  的 key 當次就被處理。
- **佇列排空改為「有界地排空」**：以 batch size + 總筆數上限 + wall-clock 預算取代
  硬寫的 50，一次執行就能清完正常規模的積壓，同時仍然有界（上限到達就回報剩餘筆數
  並結束，不得無界迴圈）。
- **single-flight**：以 `pg_try_advisory_lock` 包住整個 handler（不需要 schema
  change）；拿不到鎖就回報 `skipped: already-running` 而不是重複處理。
- **只保留 POST**，刪除 `export const GET = POST`。
- **asset GC 以 job 形式加入**（本 plan 的第二項 scope），與清理保留規則共用
  `readReferencedSceneAssetIds`，失敗只影響自己這個 job。

### 不變的部分

授權仍然只接受 `Authorization: Bearer <CRON_SECRET>`；`vercel.json` 的 cron 路徑與
排程不變（只是它觸發的 job 集合不再包含使用者清除）；既有的「刪除失敗就入列由佇列
重試」策略不變。

### 測試

- 前面的 job 拋錯時，後面的 job 仍然執行，且回應標示哪一個失敗。
- 佇列處理排在最後：同一次執行中由 asset GC 入列的 key 當次即被處理。
- GET 被拒。
- 使用者清除 job 在沒有第二個確認時不執行；dry-run 不寫入任何資料。
- 拿不到 advisory lock 時回報 skipped，且沒有任何刪除發生。
- 佇列排空達到上限時回報剩餘筆數，不會超出預算。

## Steps

1. 重跑 dangling-reference 稽核（2026-08-05 結果：39 個有資料場景全部可解析、56 個
   被引用 file id、dangling 0、unreferenced 11）。dangling 必須為 0 才能加上存檔
   驗證，否則既有場景會變成永遠無法存檔。
2. 加入 save-time 驗證與新錯誤碼，並補上「缺少資產時存檔被拒」的測試。
3. 把 cleanup 改為 scene row lock 下的單一交易，補上三種順序（清理先／存檔先／
   並行）的測試。
4. 先拆分 maintenance endpoint（具名 job、逐 job try/catch、逐 job 報告、POST-only、
   advisory lock、佇列處理排最後、使用者清除移出例行 cron 並加第二道確認與
   dry-run），並補上該節列出的測試。
5. 以 job 形式實作 unreferenced asset GC（bounded、idempotent、可核對 before/after
   counts），對現存 11 筆執行並保存結果。
6. 加入 upload skip，並量測存檔的上傳位元組數與 request 數前後差異。
7. 若 `customId` 驗證通過，評估是否讓 storage key 與身份對齊；不通過則記錄結論。

## Verification

```sh
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm lint
```

另需保存 dangling-reference 稽核、GC before/after counts，以及存檔上傳位元組／
request 數的前後比較。

## Done when

- 清理與存檔的三種順序都不會讓已提交場景失去資產位元組，且有測試覆蓋。
- 無人引用的 `file_record` 與其 storage 物件會被有界回收，稽核後為 0。
- 同一張圖在既有場景重複存檔時不再產生上傳流量與刪除往返。
- 「被引用」的判斷只有一份實作，存檔驗證、清理保留與 GC 共用它。
- Maintenance endpoint 的任一 job 失敗不影響其他 job，回應可看出是哪一個失敗；
  例行 cron 不再可能刪除使用者；endpoint 只接受 POST 且重疊呼叫不會重複處理。

## Verification notes（2026-08-06）

### 稽核與 GC（steps 1、5）

以 `apps/web/scripts/audit-scene-asset-references.ts`（唯讀，與生產程式共用
`readReferencedSceneAssetIds`）對唯一一個 Neon DB 執行：

- **前**：39 個場景全部可解析（unreadable 0）、被引用 file id 56、**dangling 0**
  （允許啟用存檔驗證）、unreferenced `file_record` **11**。
- 以 `createUnreferencedAssetGcJob()`（與 endpoint 相同的 job 程式）執行 GC：
  `deletedRecords: 11, deletedObjects: 11, enqueuedObjects: 0, truncated: false`。
- **後**：`file_record`（scene scope）56 = 被引用 56，unreferenced **0**，dangling 0。
- 冪等驗證：立刻重跑同一 job，`deletedRecords: 0`。

### 存檔上傳量前後比較（step 6）

skip 的判斷是「該 scene 已有這個 `excalidraw_file_id` 的紀錄」，因此對既有場景
重複存檔（資產未變）的成本，可直接由稽核資料計得：

- **前**：每次存檔重新上傳文件引用的全部資產。以現存 39 個場景全部重存一次計，
  為 56 個 upload requests、6,411,485 bytes，**且每個上傳都再走一次「伺服器以身份
  衝突拒絕 → 刪除剛上傳物件」的往返**（56 次 deleteFiles）。
- **後**：同樣的重存為 0 個資產 upload request、0 bytes、0 次刪除往返；只有場景
  新增的圖片才上傳。

### UploadThing `customId` 評估（step 7）——不採用

以 `~/.opensrc` 的 `uploadthing@7.7.4`（與 lockfile 版本一致）原始碼與 docs 驗證：

- SDK 與 ingest 介面把 `customId` 當 nullable 不透明字串（`x-ut-custom-id`
  header、`S.NullOr(S.String)`），全程式庫沒有唯一性宣告或衝突錯誤型別。
- Docs 只說明它可作為 URL 別名（`/f/<CUSTOM_ID>`）與 `keyType: "customId"` 查詢，
  未定義重複 `customId` 上傳是拒絕、覆寫還是併存；「重複上傳是否結構性不可能」
  無法由原始碼證明，要驗證只能對生產 UploadThing app 做破壞性實測。
- 結論：唯一性未被服務保證即不得當唯一鍵（本 plan 明定），且 step 6 的 upload
  skip 已移除當初想靠 `customId` 消除的重複上傳往返，收益也已消失。維持 DB 列
  （parent scope + `excalidraw_file_id`）作為身份的唯一權威。

### Review（Codex GPT-5.6 Sol）與接受的偏離

Pass 1 回傳 6 個 findings，全部接受並修正：

1. **cron 用 GET 觸發**（P1）：Vercel Cron 只發 GET，原本「只保留 POST」會讓每週
   例行維護 405。**偏離計畫文字**：恢復 `GET`，但它只跑例行 job 集合——GET 沒有
   body，結構上不可能表達 user purge opt-in，仍需 `CRON_SECRET`。計畫的真正目標
   （使用者清除移出例行 cron、破壞性操作不可裸 GET 觸發）不變。
2. **advisory lock 走 pooled URL**（P1）：`POSTGRES_URL` 是 Neon `-pooler` host，
   transaction pooling 下 session lock 的取得與釋放可能落在不同上游 session。改用
   `POSTGRES_URL_NON_POOLING` 的專用連線。
3. **GC 的 storage key 不耐 crash**（P2）：改為在刪除 `file_record` 的同一交易內
   把 key 寫入 `deferred_file_cleanup`（durable outbox），由排最後的 drain 當次刪
   物件；GC 本身不再直接碰 storage。
4. **GC 掃描可能卡在固定第一批**（P2）：候選 scene id 改為全取後洗牌再套
   `maxScenes` 上限，跨執行機率性涵蓋所有場景。
5. **drain 預算未逐筆檢查**（P2）：deadline 改為每筆 task 前重查。
6. **purge 部分失敗丟失逐帳號報告**（P2）：逐帳號 try/catch 記錄
   `status: deleted/dry-run/failed`，失敗時以帶 detail 的 `MaintenanceJobError`
   回報，runner 把 partial detail 附在 error outcome 上。

Pass 2（修正後的最終 pass）：無 findings，reviewer 確認六個修正正確且無新回歸。

### Checks

`pnpm --filter @drawstuff/web typecheck`（通過）、`pnpm --filter @drawstuff/web
test`（29 files / 363 tests 通過，含新增：save-time 驗證與三種順序 8、maintenance
jobs 13、maintenance route 8）、`pnpm lint`（0 errors；adapter 5 個既有 warnings）。
