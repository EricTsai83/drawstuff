# 18B P3 維護窗口與回滾

2026-10-07 已依使用者要求直接對 production 執行 `pnpm --filter @drawstuff/web db:push --verbose --strict`，未執行 SQL migration 檔。DB 已套用新版 schema；下列 SQL 維護清單保留供重新重置／回滾使用，**不要再對這次已完成的 DB push 執行 `upgrade.sql`**。2026-10-08 配套 web／Worker 已部署，protocol-6 remote smoke 通過，重置前清單中的舊 DO storage 清理已取得 ACK；完整 L3 驗收仍待完成。

## 2026-10-08 配套部署與 smoke

Vercel Production 已設定三個新版 capability secret，並重新部署為 `dpl_5nW2yDGT4mErDsW5KKshePEBLGsS`（READY）。Cloudflare 先部署維護 runtime，依重置前 manifest quiesce 兩個舊 Room 並取得 ACK；當次 namespace inventory 為零個已儲存 instance。接著獨立部署 bootstrap，建立 Lifecycle namespace `789308f282c349b58578e29496dfa502`；原 Room namespace `5f0f6fe2322c4f20b23c08018c9f9c08` 保留。Cloudflare schedules API 確認 cron 清單為空。

第一輪正式 smoke 揭露 adapter client 將原生 `fetch` 當 class method 呼叫時產生 TypeError，建房回 503；已改為透過 `globalThis.fetch` 保留原生 receiver，補上回歸測試與只記錄 HTTP status／固定 error kind 的診斷。最後手動部署的 Worker version 為 `6063aab4-c2a2-4a63-a709-d5b53607ef3e`。修正後使用兩個既有已驗證帳號，通過最大合法密文快照往返／解密、ready、正式 WebSocket 加入、撤權關線、舊 generation socket 404 與 end-room。測試不刪帳號或個人 scene；兩次單次 snapshot read 樣本為 1930ms／2883ms，不能作為 SLO 的 p95／p99 結論。Worker lint、typecheck、213 個測試、5 個維護測試、本機 product harness 與 Knip 全部通過。

初次配套部署未再次 DB push 或執行 SQL migration，quiesce 當時保留舊 SQLite／KV；後續清理結果見下方「舊物件／DO 清理」。真實 UploadThing callback、退休入口、三人 fanout、故障恢復與其他完整 L3 項目仍待驗收。

## 本次 DB push 結果

Drizzle 已新增 creation fence、operation、Lifecycle 與 tombstone 表，移除舊 outbox、`expires_at`，並加入新版 Room／Member 欄位。為加入沒有 SQL default 的 `create_operation_id`，已確認清空兩筆舊 Room；TRUNCATE 只 cascade 到共編 member、snapshot、asset 表。新版 status check 與 active-scene partial index 使用 `_v6` 名稱，讓 Drizzle 正確移除舊定義並建立新定義。

`collaboration:reset-check after` 已核對新版欄位及所有非共編 `public.drawstuff_*` 表的前後筆數／內容指紋一致；另唯讀確認新版 status check 接受 `initializing`／`ready`／`ended`，unique index 使用 `initializing`／`ready` predicate，舊 check／index 已移除。本機 13 個 PostgreSQL adapter／重置／回滾測試、TypeScript 與 schema lint 通過。受控 before／after report 保存在 git 忽略的 `.local/collaboration-cutover/`。

DB push 當時尚未部署維護 Worker、quiesce 舊 DO、新增 Lifecycle namespace 或變更 production secrets／cron。這些配套部署與 smoke 已於 2026-10-08 完成，見上節；不能將 DB push 或 smoke 成功視為完整 L3 驗收完成。

## 已準備的 artifact

- `upgrade.sql`：清空共編表後建立目前 schema。
- `rollback.sql`：清空新版共編表後恢復 protocol-5 共編 schema；以 `c6f2044` 為基礎並依 2026-10-07 production 唯讀核對校準。程式也必須配套為 protocol 5。
- `manifest.sql`：唯讀匯出密文 object key 與已知舊 DO 名稱；排除個人附件、縮圖、發布成品。
- `pnpm --filter @drawstuff/web collaboration:reset-plan`：再生 SQL，**不連資料庫**。
- `collaboration:reset-check`：在 PostgreSQL repeatable-read／read-only 交易中核對共編表名、欄位、型別與 nullable；記錄索引／constraint、舊物件清單及所有非共編 `public.drawstuff_*` 表的筆數／內容指紋。`after` 必須與同一 endpoint 的 `before` 比對一致。索引、constraint、default 仍須人工對照 SQL，工具不宣稱完整 schema 相容性。
- `wrangler.maintenance.jsonc`：同名 Worker、原 Room namespace；一般 HTTP 入口回 503，私有 quiesce 入口可批次確認停止；無 cron，DO 啟動時取消 alarm、關閉 hibernated socket。**quiesce 保留 SQLite／KV；只有另行呼叫 capability 保護的 legacy cleanup 才清除已確認的舊 storage。**
- `quiesce`：使用 authority capability 依 manifest／namespace inventory 批次喚醒舊 DO，逐一確認維護 runtime 已接手；取消 alarm、關 socket，保留 storage。
- `cleanup:legacy`：只接受 before manifest 中的舊 generation 名稱；維護端拒絕 Lifecycle、直接 ID、新版 schema 與未知表，清除後核對 SQL／KV／alarm 為空並回傳已清理 ID；CLI 保存逐批 ACK，可使用新結果檔安全重試。
- `wrangler.bootstrap.jsonc`：同一維護程式，只新增 Lifecycle namespace／binding，作為獨立手動 namespace 部署。
- `prepare:rollback`：從固定 `c6f2044` 建立本機 detached worktree，產生 protocol-5 Worker 的回滾入口／設定；保留新增的 Lifecycle namespace，該 class 仍執行封閉維護程式。沒有 remote 操作，也不覆寫既有 checkout。
- `pnpm collab:adapters`：Docker PostgreSQL 17 的競態、重置／升版／回滾及唯讀 CLI 演練；核對個人、分享、發布、Library 與附件引用。
- `pnpm --filter @drawstuff/collaboration-do test:maintenance`：workerd 驗證入口拒絕、重啟後 alarm 取消、socket 關閉及資料保留；核對 bootstrap 只變更 namespace 宣告。
- `pnpm --filter @drawstuff/collaboration-do preflight:maintenance`：兩個維護 artifact 的部署 dry-run，**不部署**。

SQL 只 DROP `drawstuff_collaboration_*`，不使用 CASCADE。未預期的外部 FK 會擋住檢查與交易。artifact 不刪 UploadThing 物件。重置適用於目前可丟棄的共編測試資料；開放正式使用後須重新設計。

## 2026-10-07 production 唯讀核對

Cloudflare CLI 登入已恢復。當時 Worker version 為 `b2d48da5-f2dc-497f-893c-1c76edc161f9`，只有 Room binding，尚無 Lifecycle；Vercel production deployment 為 `dpl_9gSwefb4PmqRLQTQMyDMb8aJgRYw`。已私下比對 Vercel production 的 `POSTGRES_URL` 與本機設定，確認 host、port、database 相同；production 尚無新版三個 capability secret。

實際 DB 的 Room／RoomMember 主鍵仍使用 `excalidraw-ericts_*_pkey` 舊名稱，outbox failure check 也允許 `dispatch-disabled`；已校準 legacy fixture 與 `rollback.sql`，並以本機 PostgreSQL 比對欄位、constraint 與 index 的 catalog 定義。這些差異只影響回滾 artifact，不改新版 schema。

唯讀 report、deployment metadata 與 namespace inventory 存於本機 git 忽略的 `.local/collaboration-cutover/`。manifest 有兩個舊 Room 名稱；當時 namespace inventory 回傳零個已儲存 instance，仍須 quiesce manifest 中的名稱。這次讀取發生於服務運行中，不能用作 migration 前後比對的最終 baseline；進入維護窗口後必須重新擷取 report 與 inventory。

## 上線前準備回滾 artifact

在 repository root 執行；產物在 git 忽略的 `.local/collaboration-cutover/protocol5-rollback`。本次準備已在本機建立此 worktree，**存在時不要重跑第一行**，也不要覆寫其部署設定。換機時才重新建立。

```sh
pnpm --filter @drawstuff/collaboration-do prepare:rollback
pnpm --dir .local/collaboration-cutover/protocol5-rollback install --frozen-lockfile --filter @drawstuff/collaboration-do...
pnpm --filter @drawstuff/collaboration-do exec wrangler types --cwd ../../.local/collaboration-cutover/protocol5-rollback/apps/collaboration-do --config wrangler.rollback.jsonc --strict-vars=false
pnpm --filter @drawstuff/collaboration-do exec wrangler deploy --cwd ../../.local/collaboration-cutover/protocol5-rollback/apps/collaboration-do --config wrangler.rollback.jsonc --dry-run --outdir .wrangler/rollback
pnpm --dir .local/collaboration-cutover/protocol5-rollback --filter @drawstuff/collaboration-do typecheck
```

保存回滾 worktree、SQL、原 web deployment ID、原 secrets／cron 設定及 dry-run 紀錄。回滾 Worker 仍需舊 `COLLAB_JOIN_TOKEN_SECRET`、`COLLAB_CRON_SECRET`、`COLLAB_OUTBOX_DRAIN_URL`，以及維護用的 `COLLAB_AUTHORITY_SECRET`；確認它們保留且 drain URL 指向配套 protocol-5 web。現有 secret 不會因新版宣告省略它而自動刪除。

## Production DB 要怎麼 migrate

這次不是全庫 `db:push`：是在維護窗口**重置共編資料並換共編 schema**。帳號、個人 scene、shared_scene、Library、附件與發布成品不在 DROP 範圍。完整執行 `upgrade.sql` 的 BEGIN 到 COMMIT，不能逐句選取執行。

### 1. 備份並隔離所有 writer

確認 Neon 正確 project／production branch／database；保存可還原的 DB snapshot 或備份與 web／Worker deployment IDs。暫停自動部署與測試分頁。

用實際部署平台的維護／存取控制隔離 **所有 web API、退休／刪除、維護／cron、UploadThing callback 與舊 deployment URL**，停止外部服務綁定 caller。窗口中也暫停個人資料寫入，才能核對前後指紋。只設 `COLLAB_ROOMS_DISABLED` 不足以擋住舊背景 writer。確認舊請求、callback 與 DB 交易已排空；維護 artifact 不保證終止部署前已開始的外部 I/O。

先準備第 5 步的 `.env.collaboration-worker.local`，包含三個新 capability 與 adapter URL（不含 DB URL）；維護入口需要至少 32 字元的 `COLLAB_AUTHORITY_SECRET`。這時只 provision secret，維護程式不會呼叫 adapter。

以下兩行是**真正的 production Worker 部署**；只有進入維護窗口才執行。先在 Cloudflare 核對 account、Worker 名稱與目前只有 Room namespace，再逐次部署、確認紀錄。若 Lifecycle 已存在，使用 bootstrap 維護設定；不要把它從宣告移除。

```sh
pnpm --filter @drawstuff/collaboration-do exec wrangler deploy --config wrangler.maintenance.jsonc --keep-vars --secrets-file ../../.env.collaboration-worker.local
pnpm --filter @drawstuff/collaboration-do exec wrangler deploy --config wrangler.bootstrap.jsonc --keep-vars
```

第一步切換封閉 runtime 並移除 minute cron；第二步只建立 Lifecycle namespace。確認產品公開／private／socket 路徑都拒絕，cron 清單為空，舊服務 caller 已停，且日誌沒有舊 adapter／DB writer。alarm 只有在 instance 再啟動時被取消；第 2 步必須依 manifest／inventory 主動 quiesce，不能假設部署本身已關完舊 socket。

### 2. 唯讀檢查與保存 manifest

在 root 的 `.env.cutover.local` 私下設定 **只有** `COLLAB_RESET_DATABASE_URL`，使用 Neon 可做一致性讀取的連線字串；不要把 URL 放進命令或聊天。可用獨立唯讀 role。將檔案權限設為 600；它與 `.local/` 報告均被 git 忽略。CLI 不使用應用程式的 `POSTGRES_URL` fallback。

```sh
pnpm --filter @drawstuff/web exec node --env-file="$(pwd)/.env.cutover.local" scripts/collaboration-reset-check.mjs before
```

保存 CLI 回傳的 `before-<timestamp>.json` 路徑，人工檢視 constraint／index 對照 `rollback.sql`。欄位不符、外部 FK、連線／權限問題都會退出失敗，**先修正 artifact，不要繼續重置**。另保存未落 DB 的在途上傳、歷史 generation DO 的 namespace inventory／log 證據：manifest 不是完整 namespace inventory。

確認 namespace inventory 覆蓋舊 generation（包含未落 DB 的 instance）。另保存 `inventory.json`，格式為 `{"roomIds":["<64位小寫hex DO ID>"],"lifecycleIds":[]}`；IDs 必須來自已核對的正確 namespace。以下命令讀取受控 manifest 與 inventory，每批最多 16 個，未收到停止 ACK 就失敗；可重跑，不刪 storage：

```sh
pnpm --filter @drawstuff/collaboration-do exec node --env-file="$(pwd)/.env.collaboration-worker.local" scripts/quiesce-rooms.mjs https://<worker-origin> /absolute/path/to/before-report.json /absolute/path/to/inventory.json
```

清單數量只代表提供的 instance 已停止，**不證明 inventory 完整**。未知歷史 generation／socket 尚未排除時，不能切換到會重新啟用 Room handlers 的正式 runtime；維持維護狀態並補齊 inventory。quiesce 路徑只存在於維護 artifact，新版正式 Gateway 不提供它。

### 3. 在 Neon 套 SQL

在 [Neon Console 的 SQL Editor](https://neon.com/blog/branching-with-preview-environments) 選定上一步同一個 production branch／database；完整貼上並執行本目錄 `upgrade.sql`。等到 COMMIT 成功；失敗時確認交易已 ROLLBACK，保持維護狀態並調查，不能換成 `db:push`。

如果本機已備有 `psql`，可在受控終端使用私下設定的連線跑同一份 SQL；不要把密碼寫進 shell history。本專案不會自動執行這個步驟。

### 4. 立即比對非共編資料

在部署任何會產生新 DB 寫入的新版程式前，將下列路徑換成第 2 步保存的**絕對路徑**：

```sh
pnpm --filter @drawstuff/web exec node --env-file="$(pwd)/.env.cutover.local" scripts/collaboration-reset-check.mjs after /absolute/path/to/before-report.json
```

工具確認新版欄位及所有非共編表指紋一致。失敗就保持維護狀態並調查；這時不要恢復流量。指紋是完整 row 的排序 MD5 摘要，用於比對意外變動，不代替備份或防竄改稽核。

### 5. 部署配套新版並驗收

web 設定三個至少 32 字元、各自獨立的 `COLLAB_IDENTITY_SECRET`、`COLLAB_AUTHORITY_SECRET`、`COLLAB_ADAPTER_SECRET`，及 `COLLAB_CONTROL_URL=https://<worker-origin>`。Worker 使用相同三個 capability，另設定 `COLLAB_ADAPTER_URL=https://<web-origin>/api/internal/collaboration/adapter`；舊 join-token secret 保留給 private regression 路徑。

將 Worker 的新增設定放在 root 的 `.env.collaboration-worker.local`（600、git 忽略），**不要包含 DB URL**。`--secrets-file` 會隨部署加入 secret，省略的既有 secret 保留；不要用 `secret put` 逐個觸發提前部署。

```sh
pnpm --filter @drawstuff/collaboration-do exec wrangler deploy --config wrangler.jsonc --secrets-file ../../.env.collaboration-worker.local
```

在仍隔離流量的窗口部署配套 web，確認 cron 空陣列、舊 drain 404、generation socket／control 404。管理介面／adapter 需要平台允許測試 principal 與私有 Worker 請求，不能為測試放開所有舊 deployment URL。

用兩個真實、已驗證的測試帳號執行 `pnpm cf:smoke <https-gateway-origin>`。私下設定 `COLLAB_HARNESS_OWNER_SUBJECT/EMAIL/VERSION`、`COLLAB_HARNESS_GUEST_SUBJECT/EMAIL/VERSION`、identity／authority secret 與允許的 `COLLAB_SMOKE_ORIGIN`。工具不建立假帳號，也不刪帳號，只建立及結束測試 Room。覆蓋最大合法密文快照往返／解密、ready、正式 WebSocket、撤權關線與 end。

`cf:loadtest` 是 30 次最大快照讀取樣本。真實附件、退休競態與三人／故障恢復的驗收證據見下節。join／保存／撤權 p95/p99、跨日重進、Neon autosuspend 與成本仍依 [18B §9](../../../plans/18b-collaboration-authority-reset.md#9-驗收矩陣) 記錄 L3；pending 不算完成。個人場景、分享、發布、Library 與附件回歸仍須完成。

### 真實附件自動驗收

在專案 root 執行 `pnpm collab:assets:remote`。此指令直接測試目前 production，不啟動 dev server、不執行 DB push／migration，也不需要既有使用者的密碼。需要已登入 Wrangler，以及 `apps/web/.env` 的 production DB、Better Auth、UploadThing、identity／authority secrets。本機以 `.local/asset-acceptance.lock` 拒絕重複執行；勿與其他驗收或 Worker 部署並行。

工具建立本輪唯一、無個資的臨時帳號／session／Room，確認正式 Better Auth 能辨識 session；以產品的資產 codec 加密合法 PNG，經正式 UploadThing presign、provider PUT 與真實 callback 完成 finalize，再下載、解密、解碼並確認含附件初始化 ready。這涵蓋 HTTP／provider／儲存流程，不宣稱 OAuth 登入或完整瀏覽器 UI 已驗收。

`finally` 先結束本輪 Room 並確認 fence，刪除限定 provider keys，等 provider inventory 確認移除，再刪本輪帳號與 DB 資料。待短效 proof 過期後，短暫部署只接受本輪 Room 名稱的維護 runtime（共編入口暫回 503），核對 owner、ended 與 fence ACK，執行 `deleteAlarm()`／`deleteAll()`。隨後還原測試前下載的 Worker module，核對 module SHA-256、bindings／vars、namespace ID 與維護路徑 404；正常 runtime 不含測試清理入口。此流程會產生新的 Worker deployment version，但保留原程式與設定。

成功後移除本輪 `.wrangler/asset-acceptance-*`、`.local/asset-acceptance-*.json` 與 lock；只保留 protocol-6 的可重跑驗收工具。若外部服務失效，清理／還原未確認會回傳非零並留下 mode 600 的 recovery journal、lock 與原 Worker bundle，不能把這種情況視為清理成功；先依 journal 清理本輪識別碼並用保存的 `restore/index.js` 還原 Worker，再移除 recovery 檔與 lock。SIGINT／SIGTERM 會要求在途步驟結束後清理；SIGKILL／斷電仍需要 recovery 檔。

執行 `pnpm collab:assets:remote --fail-after-upload`，可在真實 callback／下載解密成功後故意中止驗收，確認未 ready 的 Room、provider 物件與 DB／DO 仍會清理，Worker 仍會還原。故障只注入本機 runner，不更改 production 服務行為。此模式以 `expectedFailureHandled: true` 表示失敗路徑清理通過；一般模式須同時得到 `testPassed`、`cleanupPassed`、`restored` 三項 true。

退休競態分別使用 `pnpm collab:assets:remote --retire-scene` 與 `pnpm collab:assets:remote --retire-account`，兩輪依序執行。工具額外建立本輪 guest 與可刪除主體，以 owner／guest 連上 ready Room。持有真實 PostgreSQL Room row lock，確認快照寫入被阻擋後，同時呼叫兩次產品退休入口；核對 operationId 相同、主體 frozen、新建房與加入被拒、原 socket 關閉，而父資料在 storage fence ACK 前仍存在。釋放鎖後只查原 operation，確認 Lifecycle alarm 自行完成，再上傳退休前已 presign 的真實附件，驗證晚到 callback 未寫入且進入 deferred cleanup，舊寫入與重新加入亦遭拒。清理範圍涵蓋兩個測試 Room、Lifecycle、guest、scene、creation fence 與 provider keys；journal 保存原 bindings，還原檢查會有限重試並回報失敗階段。臨時清理 runtime 只對本輪 DO 暫停 alarm；部署後的維護／還原探針使用 `Connection: close` 重建連線，避免長時間 runner 沿用切換前連線而無法確認新路由。

退休拒絕 callback 的首輪測試揭露 UploadThing 7.7.4 在 `onUploadComplete` 拋錯時不送出 `/callback-result`，provider PUT 因而逾時。finalize 現在於安全 orphan 檢查完成後回傳 `{ status: "unknown" }`；此值不符合成功 content receipt，客户端保留原 intent 並查詢原操作，不立即重傳。若 orphan 檢查本身失敗，仍拋出不含儲存能力的固定錯誤，不能宣稱已安全排入清理。28 個 server／client 回歸測試、TypeScript 與相關 lint 已通過。

2026-10-08 正常流程與上傳後故意失敗的清理流程均通過；失敗流程另確認還原 Worker module 的 SHA-256 與測試前完全一致。白板與帳號退休競態重測均取得 `testPassed: true`、`cleanupPassed: true`、`restored: true`，包含晚到的真實 provider callback。前序 callback 逾時、DO 清理與還原路由未確認的各輪亦已完成限定資源清理與原 Worker 還原，相關 recovery 檔／lock 均移除。兩種退休情境的最終正常 runtime SHA-256 均與各自測試前備份一致。這些證據完成 scope 1，不涵蓋三人 fanout、延遲分位數、跨日重進、閒置與成本。

整體掃描另找到先前兩輪附件 smoke 遺留的 creation fence；已限定原測試 UUID，核對兩筆 `ended=true`、帳號／Room／snapshot／asset／operation／registration 皆不存在，provider inventory 也無對應檔名後移除。新版工具會一併刪除本輪 creation fence；所有 `asset-test-*`／`asset-guest-*` 主體、Room 與相關 fence／registration 掃描為零。

本輪 `pnpm check` 全部通過：web 902、collaboration Node 682（另 1 skipped）／workerd 79、excalidraw-adapter 117、Worker 213、maintenance 8 個測試及本機產品 harness；format、lint、typecheck、Knip 均通過。lint 尚有兩項既有測試警告，完整檢查不能取代尚未完成的正式環境驗收。

### 三人撤權與故障恢復

在 root 執行 `pnpm collab:assets:remote --access-recovery`。沿用上述鎖、journal、限定資源清理與精確還原流程，另建立 B／C 測試帳號及 C 的正式 session。臨時 runtime 保留一般產品入口，只對本輪 Room 提供 authority capability 保護的控制入口，並以該 Room 的獨立 env 副本切換 adapter；其他 Room 的 adapter 設定不變。故障 runtime 不加入正常 Worker artifact。

驗收以 A owner、B editor、C viewer 起步，確認 viewer 的加密 scene 寫入被拒；link role 只決定新成員預設角色，既有成員透過 `set-member-role` 更新。限定模式拒絕未列入清單者，允許清單讓 B 加入，移除信箱後關線並拒絕重進，owner 明確重新授權後可加入。C 改為 editor 後，三個真實 socket 以原金鑰傳遞加密 frame 並核對接收內容。

持有真實 PostgreSQL Room row lock，透過 `pg_blocking_pids` 確認 snapshot 寫入被阻擋；鎖持有期間 A/B/C fanout 仍成功，釋放後以相同 operation 完成保存。接著讓限定 adapter 回 503，確認保存不回 `written`，owner 撤銷 C 先在本地持久接手並回 `pending`，C socket 關閉且 A/B 繼續共編；C 重新加入、附件索引、prepare、finalize 均遭拒。使用撤權前的真實 presign 上傳密文，晚到 provider callback 回 `unknown` 並確認 deferred cleanup，不能當作成功 receipt。這裡注入的是 adapter HTTP 失效，沒有關閉整個 Neon endpoint。

透過 DO `ctx.abort()` 觸發實際重啟，確認 constructor 時間改變、故障狀態與撤權從 SQLite 恢復。恢復 adapter 後，只查原 revoke operation，確認 alarm 完成 fence；A/B 使用原金鑰重進仍可 fanout，C 仍被拒。撤權前未提交的舊 epoch 保存保持被隔離，新 epoch 的 owner 保存成功，原 operation 重送結果一致。收尾先停用故障注入，再還原正常 Worker；關房回應遺失時核對本地 ended 與 PostgreSQL epoch，DO 清理仍另外要求 ended／fenced ACK。未實際上傳的 presign key 以 provider inventory 確認不存在；不能把刪除 API 的失敗當作已清除。

2026-10-08 run `960c2110-74ff-48a1-92df-5421af41402a` 取得 `testPassed: true`、`cleanupPassed: true`、`restored: true`；觀察到 7 次限定 adapter 失敗，晚到真實 callback 拒絕與保存恢復均通過。最終正常 Worker version 為 `39ef1166-7d1f-4b86-8d21-5c6cbedf87e7`，module SHA-256 `4d0c5e6b04c8da40bf23e21cef3b4a6a311b30cdd0ee64081f1b1b043f6ecc89` 與測試前一致，bindings／namespace 與臨時入口消失均已核對。前序失敗輪也已完成 provider／DB／DO 清理與精確還原，暫時 recovery 工具、journal、lock 與生成 runtime 全部移除；最後掃描 `asset-test-*`／`asset-guest-*`／`asset-peer-*` 的帳號、Room、creation fence、registration、tombstone 與 lifecycle subject 都為零。

驗收前發現授權入口的撤權原先先等 adapter 註冊，外部失效會阻擋本地撤權。`e7d6bd1` 改為在有效 owner proof 與本地授權檢查後先持久撤權／fence，未確認屏障保持 pending；增加權限的入口仍需遠端註冊。新增 workerd 回歸確認非 owner 拒絕、原撤權冪等且未呼叫 adapter、故障時重新授權失敗。Worker lint、typecheck、214 個測試、maintenance 8 個測試、product harness 與 Knip，以及 remote runner lint／語法檢查均通過。這完成 scope 2；效能分位數、跨日／閒置／成本及完整回歸仍待後續 scope。

### 3A：典型熱場景效能量測

在 root 執行下列命令；macOS 的 `caffeinate -i` 僅在子程序存活期間防止閒置睡眠，不阻止螢幕關閉、不修改永久電源設定。關蓋或手動睡眠不在此保護範圍。其他系統直接執行 pnpm 指令並自行保持主機與網路可用。

```sh
caffeinate -i pnpm collab:assets:remote --performance-typical-hot
```

固定 20 筆 warmup、200 筆正式保存／加入配對樣本，單一測試 Room、兩個已驗證測試身分。第一次 Room 存取由正式 Vercel `collaborationAuthority.execute` 建房入口發出，避免本機預建改變 DO 初始放置條件；不設定 location hint。Cloudflare 的 [放置文件](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint) 說明初次請求會影響位置，實際 DO 所在地仍未量測。

每筆使用精確 256 KiB 的合法快照 JSON，引用一個約 64 KiB、含合法 PNG 的新附件密文。保存計時包括客戶端加密、正式 presign／provider PUT／真實 callback、必要的原 intent 查詢，以及 snapshot `written`；初始化／建房不混入保存。加入包括 socket 驗權、binary 基線下載／解密／解碼、授權索引、附件下載／解密／解碼，最後驗證加密 frame 可傳遞與解密；不只計 upgrade。固定 presence 流量維持 DO 熱態，但不宣稱獨立確認 Vercel／Neon 每筆皆無冷啟動。

此 runner 使用 live fixture proof 直連私有 Gateway，沒有計入 OAuth、web proof 簽發、一次性金鑰衍生、web snapshot／join 的速率限制或完整畫布呈現；不能作為全 app UI 延遲。分段記錄 crypto、upload、snapshot、join socket／baseline／assets 與 fanout，DO→Vercel 與 adapter→Neon 的獨立 span 仍待後續補齊。原 P0 門檻不變：保存 p95 ≤ 3s／p99 ≤ 8s，加入 p95 ≤ 3s／p99 ≤ 5s；nearest-rank 分位數包含全部正式成功樣本，不丟棄慢樣本，故障／pending 另記。

兩個測試身分與唯一 Room 沿用限定清理流程；長測試的 owner session 僅在該 fixture 設 120 分鐘，收尾刪除。生成的 runtime／journal／lock 在確認 provider、DB、DO 與 Worker 還原後移除。機器可讀報告寫入 `docs/performance/collaboration-production-3a.json`，含原始數值、完成／門檻／清理狀態、commit、tool SHA-256 與測試前正常 Worker SHA-256，不含身分、key、物件 URL 或 payload。樣本不足或門檻未過仍保留報告並回非零，不能標為驗收通過。

量測先揭露附件索引的 adapter 格式落差：正式服務回 `{ assets: [...] }`，DO 卻解析陣列，導致合法讀取 503。`a64e42d` 已對齊格式、更新 product fixture 並新增缺漏 ID 回歸；Worker lint、typecheck、215 個測試、maintenance 8 個測試、harness 與 Knip 通過，修正已部署。首輪故障與後續初始化方法校準的 warmup 都已限定清理、精確還原，沒有將它們當作正式樣本。

2026-10-08 的 [3A 正式報告](../../performance/collaboration-production-3a.json) 完成 20 筆 warmup 與 200 筆正式配對樣本，請求失敗與初始 pending 均為零；**量測完成，但效能驗收未過**。

| 項目 | p95 | p99 | 原門檻 p95／p99 | 結果 |
| --- | --- | --- | --- | --- |
| 典型保存 | 4,807.18 ms | 5,828.91 ms | 3,000／8,000 ms | p95 未過 |
| 典型加入 | 3,553.04 ms | 4,480.95 ms | 3,000／5,000 ms | p95 未過 |

保存最高 18,987.61 ms、加入最高 7,207.26 ms，全部保留。客戶端分段中，upload p50 為 3,041.12 ms、snapshot 為 996.76 ms；加入的附件索引／下載／解碼 p50 為 1,957.06 ms。這些數字指出應先追查附件路徑，但不足以判定平台或跨雲根因；各分段分位數不能直接相加當總分位數。下一輪先定位並改善 p95，再依原門檻重測；3B／3C 及完整跨雲 span 仍未完成。

Provider／DB／DO 限定清理通過，正常 Worker 精確還原至 version `5f7dbe32-4c37-408b-93e4-d21e3ba66094`，來源 SHA-256 與測試前一致；臨時 runtime、journal 與 lock 已移除，與本輪程序綁定的防睡眠保護也已結束。CLI exit 1 是效能 gate 未過的預期結果，不是清理失敗；未執行 DB push／migration。

### 3A：附件路徑診斷與重播寫入改善

`pnpm collab:assets:remote --performance-typical-hot-diagnostic` 使用同一真實流程，但固定 20 warmup／20 診斷樣本，另外寫入 [診斷報告](../../performance/collaboration-production-3a-diagnostic.json)，不覆寫上述 200 筆驗收基準。`purpose=latency-diagnostic`、`requiredSamples=200`、`gatePassed=false` 明確區別診斷完成與驗收；診斷的 `testPassed=true` 只代表流程完成，原 P0 gate 仍未通過。

2026-10-08 的修正前診斷請求失敗為零，保存／加入 p50 分別為 4,001.54／3,124.02 ms。上傳分段 p50 為 presign 1,006.70 ms、PUT 與真實 callback 1,991.28 ms；加入分段為索引 226.31 ms、provider 密文下載 1,722.68 ms、解密／解碼 0.38 ms。測試 recovery journal 寫入 p50 0.72 ms，仍計入原保存總耗時以維持邊界。下載段包含網路與 body 讀取，PUT 段包含 callback，尚無法將 provider、Vercel 或跨區網路單獨歸因。

每筆都是新上傳附件的第一次下載，因此這是熱 DO／新附件流程，不代表 provider CDN 已暖。沒有用預先下載、移除 callback、快取索引或放寬原門檻來提高分數。下一步優先檢查 provider 下載與 callback 路徑，而不是把主要延遲歸因於附件索引。

本機 token 僅在記憶體內解析，輸出只允許 region alias，確認設定為 `sea1`；未輸出或記錄 token／API key／app ID。使用者確認目前為免費方案。UploadThing [官方區域文件](https://docs.uploadthing.com/concepts/regions-acl) 將它列為美國西部預設區域；調整 region 需付費方案，而且只影響新物件，既有物件不會自動搬移。維持免費方案，不改平台設定或搬移物件；目前只能列為待驗證的跨區因素，下一步先細分 callback 與 CDN 下載路徑。

另改善 adapter 的重複註冊：保持 live lifecycle／帳號／來源鎖定與驗證、create intent 綁定；當 registration 的版本與 owner flag 不需更新時省略 upsert，需提升 owner 或更新版本時仍寫入。不宣稱這項小幅 SQL 改善解決 provider 主要延遲。22 個身分、授權入口與退休 adapter 測試、web typecheck 與變更檔 lint 通過；測試確認重播不改寫資料列版本，frozen 身分仍拒絕，必要更新仍完成。

診斷資源 provider／DB／DO 清理、正常 Worker 精確還原通過；還原 version `45fa9b09-0691-4639-9733-8cb66aa757c5`，臨時 runtime／journal／lock 已移除。此報告量測的是改善前的正式服務；改善後仍待重新量測，不以診斷樣本當作 200 筆正式驗收。

改善 commit `df3776d` 已隨 `c8f7c2e` 推送 main，Vercel 回報部署成功後再次執行 `pnpm collab:assets:remote`。真實上傳、callback、索引、下載與解密、provider／DB／DO 清理、正常 Worker 精確還原全部通過；還原 version `ce6003e3-ab36-48eb-9230-cd0b340a6554`。另核對測試前綴的帳號／房間／附件／快照殘留為零、暫存檔與目錄已移除。這是改善後行為 smoke，不是效能分位數驗收；下一步仍為免費方案下的傳輸／callback 診斷與原門檻重測。

### 3A：Provider 回應分段與首次／重讀診斷

在 root 執行 `caffeinate -i pnpm collab:assets:remote --performance-provider-diagnostic`，固定 20 warmup／20 診斷樣本。報告另存 `docs/performance/collaboration-production-3a-provider.json`，不覆寫既有診斷與 200 筆驗收基準。presign、provider PUT＋receipt、首次附件下載分別記錄 fetch 回傳 headers 前的時間與讀完 body 的時間。headers 耗時包含 DNS／連線／請求／伺服器等待，不是單獨的 callback、provider CPU 或精確 TTFB；body 耗時亦受 fetch buffering 影響。

首次加入、下載／解密／解碼、frame 驗證與 `joinMs` 停表後，才以相同 URL 額外讀一次密文並核對內容。重讀只記獨立診斷值，沒有換 URL、加 cache header 或預暖下一份附件，也不計入原保存／加入分位數。cache 狀態只保留允許列出的 `CF-Cache-Status` 值，未提供時記 `unreported`；它不等於 MISS，也不能據此判斷 provider 全部快取層。UploadThing [官方存取契約](https://docs.uploadthing.com/working-with-files) 使用其 CDN URL，不改成底層 bucket URL。

2026-10-08 的 [provider 診斷報告](../../performance/collaboration-production-3a-provider.json) 完成 20 warmup／20 配對樣本，失敗與 pending 為零，報告基底 commit `2ef4b86`。

| 客戶端量測段 | p50（ms） | p95（ms） |
| --- | --- | --- |
| Presign：headers 前 | 1,014.63 | 1,178.01 |
| Presign：body | 0.64 | 1.29 |
| PUT＋receipt：headers 前 | 2,026.11 | 2,127.62 |
| PUT＋receipt：body | 0.62 | 0.83 |
| 首次附件下載：headers 前 | 1,527.67 | 1,640.71 |
| 首次附件下載：body | 207.67 | 398.81 |
| 重讀附件：headers 前 | 926.47 | 1,098.33 |
| 重讀附件：body | 208.23 | 230.72 |

首次完整下載 p50 1,762.44 ms、重讀 1,133.28 ms；解密／payload 解碼 p50 僅 1.07 ms。等待 headers 是主要量測段，重讀仍超過一秒，因此不能只歸因於首次傳輸或解密。首次與重讀各 20 筆全部為 `unreported`，沒有 HIT／MISS 證據；不能把第二次下載稱為已確認的熱 CDN 場景。不同分段的 p50／p95 不直接相加當總分位數。

本輪沒有改產品流程或平台設定；維持免費方案／sea1。下一個改善範圍應加入伺服器端 presign／callback／Gateway／adapter 分段，與客戶端等待對照，再決定可降低哪段往返；不能從 PUT headers 前的 2 秒直接宣稱 callback 自身耗時 2 秒。保存／首次加入診斷 p95 4,133.31／3,414.84 ms，原 200 筆正式 gate 仍未通過。

Provider／DB／DO 清理及正常 Worker 精確還原通過，還原 version `7deecfd4-4b07-4461-98e5-68bee7b829ae`；再次核對測試帳號／房間／附件／快照殘留為零，暫存 runtime、journal、lock 已移除。此輪僅 client 診斷工具與證據變更，未執行 DB push／migration。

## 舊物件／DO 清理

先完成可回滾 smoke，再按受控 manifest 清理有明確共編來源且不被任何個人資料引用的物件。DO metadata 清理必須對已確認的舊 instance 停止工作、取消 alarm 並 `storage.deleteAll()`。一般 quiesce 保留資料；legacy cleanup 是獨立、capability 保護的維護入口，正常 production Gateway 不提供它。

2026-10-08 已對重置前 manifest 的兩個舊 generation 執行 cleanup 並取得 ACK，服務已恢復。兩個 ID 清理前後的 `hasStoredData` 都是 false：它們原本沒有持久內容，本次仍明確執行 `deleteAlarm()`／`deleteAll()` 並確認 storage 為空。Cloudflare inventory 仍列出這兩個確定性 ID，不等同仍有持久資料。其餘七個 Room instance 的存在與 storage flag、Room／Lifecycle namespace ID 前後一致；這個比對不宣稱所有新 Room 的內容指紋已驗證。manifest 的 provider object key 清單為空，未刪任何 UploadThing 物件或 DB 資料。

受控報告保存在 git 忽略的 `.local/collaboration-cutover/legacy-cleanup-result.json`、`cleanup-inventory-before.json`、`cleanup-inventory-after.json` 與 `cleanup-comparison.json`。還原的 Worker version 為 `b2cab370-4df4-41e9-838d-fdf68d02d398`。只對已確認的清單宣稱完成；未知歷史 generation 必須另行核對，不可直接以目前 namespace 全部 ID 當清除名單。

重跑時先保存正確 namespace inventory，確認沒有需要保留待辦／alarm 的新 active 房間，再短暫部署 bootstrap 維護 runtime（Lifecycle 已存在，不可用只有 Room 的 stage-one config）。在 root 使用相同私下設定的 authority secret，結果檔必須是新路徑：

```sh
pnpm --filter @drawstuff/collaboration-do exec node --env-file="$(pwd)/apps/web/.env" scripts/cleanup-legacy.mjs https://<worker-origin> /absolute/path/to/before-report.json /absolute/path/to/new-cleanup-result.json
```

入口只清除沒有自訂表／KV 的空 Room，或僅含 `room_meta`／`revocation_cutoffs` 且 `schema_version=2` 的 legacy Room。拒絕新版／未知 storage 時回 409；一批若中途失敗，前面的個別 DO 可能已清除，CLI 記錄 incomplete，重試同一清單可重新取得 ACK。清理後核對 inventory，恢復正常 Worker 並重跑 remote smoke；不可刪除 namespace 來清資料。

## 回滾

先重新部署 **bootstrap 維護 artifact** 停住新版 Worker（Lifecycle 已存在，不能用只有 Room 的第一階段設定），隔離 web、alarm／背景工作與 callback，確認在途寫入排空。保存新版共編 object／DO 清理清單，依相同 quiesce 入口喚醒清單中的 Room／Lifecycle（inventory 的 `lifecycleIds`）；未確認停止不能換回正式 handlers。

共編測試內容可丟棄時完整套 `rollback.sql`，恢復配套 protocol-5 web，然後部署上面已準備／dry-run 的 Worker：

```sh
pnpm --filter @drawstuff/collaboration-do exec wrangler deploy --cwd ../../.local/collaboration-cutover/protocol5-rollback/apps/collaboration-do --config wrangler.rollback.jsonc
```

它保留 Room 與 Lifecycle namespace；Room 回到 protocol 5，Lifecycle 仍封閉。不能直接 rollback 到建立 Lifecycle 之前的 Worker version，也不能刪除 namespace 來回滾。舊 minute cron 只可在配套舊 web drain 與 secrets 已就緒後恢復。隔離期間先 smoke、驗證個人資料，再恢復流量。Neon 實際 schema 不符 fixture 時，使用維護前備份或先修正 artifact；不能讓舊程式接新版 schema、只回滾其中一個服務或猜測套用。

## 已核對的官方文件

- [Cloudflare class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)：只出現在 code 的 class 不會自行建立 namespace；live class 宣告必須保留。
- [Cloudflare secret 部署](https://developers.cloudflare.com/workers/configuration/secrets/)：`--secrets-file` 隨 deploy 套用；`secret put` 會立即部署。
- [Cloudflare storage 清理](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)：取消 alarm 及 `deleteAll()`；只刪 SQL tables 不等同完整 storage 清理。

指令已用專案固定 Wrangler 4.125.0 的 help、schema 與 dry-run 核對。dry-run／本機演練不能代替 remote namespace 狀態、真實 provider callback 或 production L3 驗證。

### 3A：附件伺服器分段診斷

`caffeinate -i pnpm collab:assets:remote --performance-server-diagnostic` 固定 20 warmup／20 配對樣本，另存 `docs/performance/collaboration-production-3a-server.json`。保留首次附件下載、真實 PUT／callback receipt 與原保存／加入停表邊界，不覆寫 200 筆驗收基準。

公開 presign 只接受由 authority secret 簽出的 60 秒 HMAC 診斷能力，仍須通過既有 session、rate limit 與 Room 授權。一般 cookie、單純啟用 header 或過期／錯誤簽章不會開啟計時。私有 Gateway／adapter 先驗證既有服務授權再接受診斷 flag。callback 僅沿用 UploadThing 已驗證的 middleware metadata；一般上傳 receipt 形狀保持不變，診斷 receipt 才附加允許列出的數值。

配對欄位涵蓋 presign session／rate limit／SDK handler、identity issuance、Gateway round trip／dispatch、DO asset handler，以及 register／write／read-assets adapter round trip 與服務端 DB transaction。這些為巢狀區間，不能相加分位數；DB 區間包含連線、網路、鎖等待與查詢，不等於 Neon CPU。Worker `performance.now()` 只用於跨 I/O 的 elapsed timing，不用來判斷同步 CPU。snapshot、provider callback dispatch、純網路／provider 內部耗時與獨立 cold-start 分類仍未量測。

報告只記錄數值、commit／工具 hash 與清理還原結果，不記錄 token、帳號、provider key、URL 或 payload。缺少必要服務端計時會讓診斷失敗並進入原限定清理；保留 recovery journal 直到 provider／DB／DO 與正常 Worker 還原全部確認。

2026-10-08 的 [伺服器分段報告](../../performance/collaboration-production-3a-server.json) 完成 20 warmup／20 診斷樣本，失敗與初始 pending 均為零。產品與量測工具皆為已提交的 `20ba2b3`，Web 部署成功後使用 Worker version `c31a441f-199e-46ce-baac-49cd2b6583a6` 執行；報告含工具與正常 Worker hash。

| 配對分段 | p50 ms | p95 ms |
| --- | ---: | ---: |
| 保存總耗時 | 4,357.60 | 7,377.30 |
| 首次加入總耗時 | 3,488.34 | 4,516.58 |
| 客戶端 presign | 1,116.12 | 1,290.57 |
| presign route session／rate limit | 5.58／8.43 | 8.31／10.13 |
| presign SDK handler（包含 middleware） | 937.04 | 1,064.74 |
| presign identity／Gateway round trip | 9.30／246.40 | 10.49／352.52 |
| presign DO handler／registration DB | 51.00／20.52 | 69.00／28.60 |
| PUT＋callback receipt | 2,079.66 | 5,097.65 |
| callback handler／Gateway round trip | 243.44／233.63 | 2,884.81／2,869.21 |
| callback Gateway→DO RPC／DO handler | 183.00／139.00 | 2,854.00／181.00 |
| callback adapter write／DB transaction | 90.00／46.05 | 122.00／51.15 |
| 附件索引／read-assets DB | 275.70／13.31 | 327.32／28.49 |
| 首次下載 headers 前／body | 1,528.86／204.64 | 2,081.73／434.21 |

按**每筆配對**相減後再取分位數，SDK handler 扣除 middleware 的 session＋identity＋Gateway 區間，剩餘 p50 713.27 ms／p95 716.97 ms。這顯示 presign 還有 SDK 內部／外部 I/O 等待，但沒有 SDK outbound tracing，不能直接稱為 provider CPU 或純網路延遲。PUT＋receipt 扣除 callback handler，剩餘 p50 1,832.07 ms／p95 2,212.85 ms，仍混合上傳、provider 處理、callback dispatch 與回應傳輸。

最慢保存樣本為 12,657.99 ms，其中 PUT＋callback 8,697.87 ms；callback Gateway→DO RPC 6,310 ms，而 RPC 內 DO handler 139 ms、registration DB 20.47 ms、write DB 46.05 ms。相差的 6,171 ms 發生在 handler 外，值得下一輪追蹤 dispatch／排程或其他平台等待；目前沒有證據判定為冷啟動、DO input gate 或 Neon 鎖。snapshot 同筆另耗時 2,942.95 ms，尚缺伺服器分段。

最慢加入樣本為 11,285.48 ms，索引 279.16 ms、首次下載 9,593.31 ms，其中 body 7,511.53 ms；解密／解碼僅 0.66 ms。這是傳輸等待的定位，尚不能區分本機網路與 provider streaming。慢樣本完整保留；此輪新增計時而非產品延遲改善，也不能與前輪不同時間窗口直接當作效能回歸。

`testPassed=true` 代表診斷流程完成，`gatePassed=false`；原 200 筆正式 gate 仍未通過。下一個範圍為 RPC handler 外等待、SDK presign 與下載傳輸的來源定位，依確認的瓶頸改善後重測，再完成 3B／3C。維持免費方案與 sea1，不關閉 callback receipt、live lifecycle／generation 屏障，也不以重讀代替首次下載。

Provider／DB／DO 清理及正常 Worker 精確還原皆通過，還原 version `950f8acc-4054-423b-b3d1-7b0f309e8c74`。另以唯讀查詢核對測試前綴帳號、房間、附件、快照、registration、tombstone 與 creation fence 殘留全為零，runtime／journal／lock 無殘留，暫時清理入口已移除；沒有 DB push／migration 或方案／區域變更。

### 3A：Presign 背景工作生命週期改善

UploadThing 7.7.4 的 `RouteHandlerConfig.handleDaemonPromise` 在 production 預設為 `await`；已依專案 lockfile 版本的 SDK source／型別確認，它會等待 metadata registration daemon 完成才回 presign。SDK 同一設定也管理 verified callback 的工作生命週期。原伺服器配對報告在 middleware 之外仍有約 713 ms 的 SDK 等待，因此將 handler 設定接到 `next/server` 的 `after(() => promise)`，由 Next.js 保留背景工作，提前回傳 HTTP response。這是 SDK 公開設定，不修改依賴或以 `void` 丟棄工作；[Next.js 官方 after 契約](https://nextjs.org/docs/app/api-reference/functions/after)支援 Route Handlers 並沿用部署平台的 waitUntil 生命週期。

`awaitServerData` 維持預設 true；provider PUT 仍須等真實 `onUploadComplete` 的 content receipt，所有 live session、Room、lifecycle、generation 與 storage fence 仍執行。改善預期是移動 metadata registration 與 callback HTTP ACK 的等待位置，不預先宣稱端到端保存省下相同毫秒數。

`caffeinate -i pnpm collab:assets:remote --performance-presign-diagnostic` 沿用 20 warmup／20 組伺服器配對診斷，另存 `docs/performance/collaboration-production-3a-presign.json`，保留改善前 server 報告與原 200 筆 gate。檢查背景 metadata 成功抵達 provider、verified callback 完成、首次下載／解密與原限定清理；同時對照 presign 的縮短是否只是轉移到 PUT＋receipt 等待。RPC handler 外與下載 body 慢樣本的根因仍待獨立追蹤。

2026-10-08 的 [presign 改善後報告](../../performance/collaboration-production-3a-presign.json) 完成 20 warmup／20 組診斷，基底與工具 commit `426f297`，工具無未提交修改。真實 metadata registration、callback receipt、索引／首次下載／解密全部完成，失敗與初始 pending 均為零。

| 分段 | 改善前 p50 ms | 本輪 p50 ms | 本輪 p95 ms |
| --- | ---: | ---: | ---: |
| 客戶端 presign | 1,116.12 | 474.43 | 745.06 |
| SDK handler（包含 middleware） | 937.04 | 288.74 | 356.95 |
| SDK handler 扣除每筆 middleware 區間 | 713.27 | 10.54 | 12.75 |
| PUT＋callback receipt | 2,079.66 | 1,922.24 | 2,273.89 |
| callback handler | 243.44 | 278.47 | 354.11 |
| 保存總耗時 | 4,357.60 | 3,606.70 | 4,945.67 |
| 首次加入總耗時 | 3,488.34 | 3,481.15 | 4,948.49 |
| snapshot 保存 | 1,172.62 | 1,123.25 | 2,306.18 |
| 首次附件下載 | 1,733.51 | 1,768.05 | 1,999.56 |

SDK 剩餘區間從約 713ms 降為 11ms，支持 metadata daemon 已移出 presign 的同步等待；PUT＋receipt 沒有在本輪出現等量增加，真實 receipt 仍完整。兩輪是不同時間窗口的 20 筆診斷，不是隨機 A/B；不能把所有尾端波動降低都歸因於這個設定，也不能宣稱 callback RPC handler 外等待的根因已修復。

本輪最慢保存 6,850.22 ms，其中 snapshot 4,190.49 ms，presign 573.72 ms、PUT＋callback 2,083.87 ms；下一輪優先補 snapshot Gateway／DO／adapter 分段，同時區分 RPC handler 外與傳輸等待。原 200 筆 gate 與 3,000 ms p95 門檻不變，`gatePassed=false`；保存／加入仍未達標，不重複以小樣本宣稱 P3 完成。

Provider／DB／DO 清理與正常 Worker 精確還原通過，還原 version `eab0e029-5f65-4027-8860-3635d9ffe060`，正常 Worker hash 與改善前相同。再次唯讀核對測試前綴的帳號、房間、附件、快照、registration、tombstone、creation fence、lifecycle subject 全為零；暫時入口回 404，runtime／journal／lock 全已移除。沒有 DB push／migration、Worker 產品邏輯或免費方案／sea1 設定變更。

### 3A：Snapshot 伺服器分段診斷

`caffeinate -i pnpm collab:assets:remote --performance-snapshot-diagnostic` 固定 20 warmup／20 配對樣本，另存 `docs/performance/collaboration-production-3a-snapshot.json`。沿用改善後的 UploadThing 生命週期與真實上傳／callback／首次下載／解密流程，不覆寫之前的診斷或 200 筆正式 gate。

只有先通過 service bearer 與 identity proof 的 Gateway 診斷請求，才開啟 snapshot 數值 header；一般 snapshot 收據與 binary payload 形狀不變。每筆記錄 Gateway→DO RPC、DO handler、registration adapter／DB、DO acceptContent、DO 接收密文、adapter binary write／DB transaction、adapter 接收密文、DO settleContent，以及 snapshot read adapter／DB。Response 不為量測而額外緩衝；串流仍逐段重驗授權，body quota 仍持有至消費／取消完成。

所有區間都使用各執行環境自己的 elapsed timer，不跨機器相減 timestamp，也不新增 sync／write 或改 output gate。`room`／`gatewayService` 在 Response headers 可回傳時停表，read body 後續傳輸不包含在其中；adapter read 則包含讀完密文，client `joinSnapshotMs` 仍包含完整下載、解密與 decode。Server spans 是巢狀區間；對照時逐筆比較，不相加分位數。`snapshotAttempts` 記錄 write 嘗試數；多次嘗試時 header 只保留各階段最近的觀測值，不能把它當成所有嘗試總和。

缺少必要分段會讓診斷失敗並清理；不移除慢樣本或放寬 P0 門檻。RPC handler 外等待仍混合 dispatch、排程、返回時的持久化屏障與網路，沒有平台 trace 時不宣稱已單獨分類。

2026-10-08 的 [snapshot 配對報告](../../performance/collaboration-production-3a-snapshot.json) 完成 20 warmup／20 診斷樣本，基底與工具 commit `b87a6f4`；Web 部署成功後，使用 Worker version `f94d1e1f-a4bc-4f0d-b326-7f7a6e30e3a9` 開始量測。必要欄位皆存在，失敗、pending 與多次 write 嘗試均為零。

| 分段 | p50 ms | p95 ms |
| --- | ---: | ---: |
| 保存／首次加入總耗時 | 3,107.81／3,185.77 | 4,515.52／3,738.21 |
| client snapshot 保存 | 1,052.50 | 1,337.26 |
| snapshot Gateway→DO RPC | 240.00 | 441.00 |
| snapshot DO handler | 201.00 | 277.00 |
| registration adapter／DB | 56.00／23.04 | 82.00／32.08 |
| DO 接收密文 | 0.00 | 38.00 |
| adapter write round trip／DB transaction | 133.00／74.39 | 195.00／106.37 |
| adapter 接收密文 | 0.68 | 1.62 |
| read Gateway→DO RPC／DO handler | 169.00／135.00 | 254.00／168.00 |
| read adapter／DB transaction | 59.00／21.30 | 85.00／27.41 |

按每筆配對相減後再取分位數，client snapshot 耗時扣除 Gateway→DO RPC 的剩餘區間為 p50 775.14 ms／p95 913.02 ms；這仍包含 Gateway HTTP overhead、client／edge ingress、傳輸與回應解析，不能直接稱為純網路 RTT。RPC 扣除 DO handler 為 p50 30 ms／p95 183 ms；adapter write 扣除 DB 與 adapter body receipt 後為 p50 60.97 ms／p95 92.48 ms，亦可能包含 runtime output gate 等待，不單獨歸因於跨雲網路。

DO acceptContent／settleContent 皆記 0ms，不能解讀為沒有 SQLite 寫入、持久化成本或 CPU 耗時。依 [Workers timer 契約](https://developers.cloudflare.com/workers/runtime-apis/performance/)，同步工作與已就緒的 Promise 不一定推進 `performance.now()`；本輪未加 storage sync，因此隱含持久化屏障可能計入後續 outbound I/O 或 RPC 返回。body 0ms 亦只表示這個觀測區間未推進 timer，不表示密文沒有經過網路。

最慢 snapshot 樣本 1,525.92 ms，RPC 671 ms、DO handler 516 ms、registration DB 120.15 ms、write DB 250.95 ms；剩餘 client 區間 854.92 ms。原先 4.19 秒 snapshot 與 6.31 秒 callback RPC 尾端本輪未重現，不能因此宣稱根因已修復。部分樣本的保存與加入共同變快，本輪只新增計時，保留這些波動而不把它們當作產品改善。presign p50 仍為 420.20 ms，前輪背景生命週期改善持續有效。

下一個範圍優先定位 client／edge ingress 與回應傳輸，核對 headless 量測及瀏覽器 HTTP 傳輸契約，再決定需調整測試工具或產品路徑；RPC handler 外多秒尾端仍須平台證據或重現。保存／加入 p95 超過 3,000ms，`gatePassed=false`，原 200 筆正式 gate 不變，P3 尚未通過。

清理曾回 409，限定 cleaner 等待退休／fence／socket 屏障後成功；未繞過屏障。Provider／DB／DO 清理及正常 Worker 精確還原通過，還原 version `12546067-f5e1-4906-9763-0cc14f764961`，module hash／bindings 符合測試前備份。再次唯讀確認測試前綴帳號、房間、附件、快照、registration、tombstone、creation fence、lifecycle subject 全為零；runtime／journal／lock 全已移除，暫時入口回 404。沒有 DB push／migration、方案或區域變更。

### P3：完整檢查與平台觀測入口核對

2026-10-08 完整 `pnpm check` 通過：format、lint、typecheck、各套件測試及 Knip 全部成功，合計 2,015 個測試通過、1 個跳過；lint 保留 2 個既有 warning。首次檢查發現 `./performance` 已是公開 export，但套件契約測試的明列清單漏更新；補齊後重跑完整檢查成功。這只完成 Scope 5 的 repo 檢查，不能替代 §9 的正式環境回歸。

Neon CLI 已登入；正式專案屬 Vercel 管理的 organization，需以 `projects list --org-id` 查詢，不能以個人 projects 空清單判定無權限。透過 GET `/projects/{project_id}/endpoints` 核對本機正式連線 hostname 與 endpoint 相符；2026-10-08T06:08:04.700Z 觀測到 `current_state=idle`、`suspend_timeout_seconds=0`，region 為 `aws-ap-southeast-1`，最後活動時間為 05:54:24Z。0 表示使用預設 suspend timeout，預設閒置 5 分鐘；[Neon scale-to-zero 契約](https://neon.com/docs/manage/endpoints#scale-to-zero-configuration)說明 idle 狀態與預設窗口。

以上只透過平台 API 查詢，沒有連線查 PostgreSQL、修改 compute 或喚醒資料庫。單次 idle 狀態不是「無使用者、無待辦、授權週期查詢為零」的受控窗口證明，也不是跨日重進證明。GET `/consumption_history/v2/projects` 查詢本專案的 hourly compute／public network transfer 時，平台明確拒絕：`This endpoint is not available. It is included with Launch plans and above.` 因此精確用量仍需其他平台入口或資料來源；不為測試升級方案，也不能將 unavailable 解讀為零成本。

以系統 curl 的 HTTP/2 請求確認 Web session 與 Worker health 公開端點均協商 HTTP/2；這只證明端點支援，不證明 Node headless runner 或真實瀏覽器的 authenticated upload／snapshot 請求使用相同傳輸契約。這部分仍需核對，正式 200 筆效能 gate 尚未重測或通過。

本輪沒有新增 production 測試資源、部署臨時 Worker、DB push／migration 或修改平台設定；本機完整檢查暫存 log 已移除。下一輪仍按 Scope 3A 傳輸契約與尾端定位、3B／3C、Scope 4、Scope 5 的未完成項目執行，不因完整檢查成功而移除 18B plan。

### 3A：明確協商 HTTP/2 的完整恢復量測

原 runner 的 Node 24.18.0／bundled Undici 7.28.0，在真實 Web／Gateway 端點實際協商 HTTP/1.1。新增 `--performance-http2`：僅量測請求使用獨立 Undici 7.29.1 dispatcher，透過公開 `allowH2`／connector API 協商，保留 HTTP/1.1 fallback；provider SDK 清理、Cloudflare API、初始化與 WebSocket 不改 transport。只保存 web／gateway／provider 的協商協定與連線／請求數，不保存 host、URL、headers 或 secret。此 dev dependency 不改產品 runtime。

此模式仍要求 20 warmup／200 正式配對樣本及原 p95／p99 門檻，包含全部新附件上傳／receipt、snapshot 保存、持久基線與附件下載／解密、即時 fanout。同步收集 snapshot 與 asset server spans，另存 HTTP/2 報告，不覆寫舊 gate 或診斷。它是持久內容完整恢復量測；產品會在加入後競速 peer／durable baseline 並在背景載入缺失圖片，因此不能把這份數字稱為真實 UI 首次可互動時間。不能為並行讀取而在 socket 訂閱前讀 baseline，否則會引入漏接編輯的窗口。

第一次執行的[未完成報告](../../performance/collaboration-production-3a-http2-incomplete.json)保留工具 commit `4ed68e2`、20 warmup 與 156 筆完成樣本，第 157 筆 fanout 超過 10 秒未收到而停止。Web／Gateway／兩個 provider origin 的量測連線全部協商 h2，沒有 h1 fallback；仍不能以此證明所有瀏覽器的協定。失敗樣本未計入完成樣本的分位數，但失敗率有記錄，`completed=false`、`gatePassed=false`，不能當成 200 筆驗收。

完成樣本的保存 p95 4,787.60 ms、加入 p95 5,174.01 ms；最慢保存的 snapshot client 耗時 7,111.20 ms，Gateway→DO RPC 494 ms、DB write 69.52 ms。HTTP/2 沒有消除 client／Gateway HTTP 路徑的多秒尾端，亦不能從這些區間單獨辨認 edge、傳輸或冷啟動。fanout 逾時時原工具缺少 socket state／close code，根因未確認；已補限定數值的失敗階段、socket state／close code 與已完成 client segments，socket close／error 立即使測試失敗，不增加等待期限、不重送 frame 或略過失敗。

本次 provider／DB／DO 清理通過，正常 Worker 還原 version `c78b70c8-4ece-4539-8af6-6fe68782e9dd`，module hash 與 bindings 精確符合測試前備份；runtime／journal／lock 已移除。先保留失敗報告與補強後工具，再用全新限定資源重跑一次；不把兩輪拼成 200 筆或將失敗輪丟棄。

重跑的[第二份未完成報告](../../performance/collaboration-production-3a-http2-retry-incomplete.json)使用工具 commit `e08b835`、全新房間／帳號／provider 物件，亦完成 20 warmup／156 筆樣本；第 157 筆在 `provider-put` 階段解析 callback `serverData` 時發生 ZodError，owner socket 當時仍為 OPEN。Web／Gateway／provider 連線全為 h2，已完成 snapshot 全部只有一次 write 嘗試、完成樣本 pending 為零；失敗仍有記錄，`completed=false`、`gatePassed=false`。這不是前次 fanout 逾時的重現或修復證明。

| 完成樣本的區間 | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: |
| 保存 | 2,705.95 | 3,961.53 | 4,560.22 |
| 加入（持久內容完整恢復） | 3,236.44 | 4,255.83 | 4,537.47 |
| Presign | 421.55 | 930.04 | 1,906.47 |
| Provider PUT＋callback receipt | 1,346.38 | 1,774.62 | 2,747.16 |
| Snapshot 保存 | 760.33 | 1,577.54 | 1,966.67 |
| Join socket | 662.87 | 1,487.01 | 1,707.43 |
| 首次附件下載 | 1,541.05 | 1,733.20 | 1,862.98 |
| Snapshot Gateway→DO RPC | 282.00 | 744.00 | 1,529.00 |
| Snapshot DO handler | 179.00 | 642.00 | 1,423.00 |
| Snapshot DB write | 55.86 | 97.03 | 1,197.11 |

最慢保存 8,312.90 ms 主要是 presign 3,377.21 ms、PUT＋receipt 4,066.01 ms，snapshot 僅 868.07 ms；callback RPC 244 ms、DO handler 146 ms、DB write 46.05 ms。逐筆 snapshot client 扣除 RPC 後，剩餘區間 p50 445.47 ms／p95 955.10 ms。不同樣本的瓶頸不同，不能只針對平均 DB 時間或單一協定宣稱根因；亦不能將兩輪差異全歸因於 HTTP/2，沒有同時間窗口的隨機對照。

兩輪都在第 157 筆停止，應追查計數、工作佇列、callback／socket 錯誤與平台日誌，但目前尚未證明固定容量限制。現有 512 附件／generation、4,096 operation result 等上限不能直接解釋這個位置。產品 callback 在 outcome 不明時可回 `unknown`，客戶端保留原 intent 再 query；本輪未保存實際 status，因此不能認定 ZodError 就是 `unknown` 或直接修改恢復邏輯。工具已追加只含允許 status tag 與 Zod issue code 的診斷，不記 provider body、錯誤 message 或私人識別資訊。

第二輪 provider／DB／DO 清理及正常 Worker 精確還原通過，還原 version `d4c2d247-1e58-4602-af7c-c9b2812f2a47`。再次唯讀核對測試前綴的帳號、Room、附件、快照、registration、tombstone、creation fence、lifecycle subject 全為零；runtime／journal／lock 已移除。沒有 DB push／migration、方案或 region 變更。下一步先補失敗 callback／fanout 的可定位證據與平台錯誤分類，確認原因後才修改產品或重跑完整 gate；不以放寬效能門檻掩蓋功能失敗，也不將兩輪合併成 200 筆。


### 即時觀測與部署干擾（2026-10-08）

第三輪 HTTP/2 資料保存於 `docs/performance/collaboration-production-3a-http2-observability-incomplete.json`，工具 commit `3720688`。20 筆暖機與 31 筆正式樣本完整通過，第 32 筆 callback 為 `written`，隨後 snapshot write 回應未通過 HTTP 200 檢查，owner socket 已以 1006 關閉。本版尚未保存該 HTTP 狀態與平台 exception 分類，因此不能宣稱特定 HTTP 錯誤或根因。完成樣本 save p95 3,777.69 ms、join p95 4,658.91 ms；不是完整 200 筆 gate。

Wrangler live tail 收到 734 個事件、51 個本輪 joined 紀錄與 2 個未能歸屬本輪的 platform exception。未保留原始訊息、URL、token、room／peer 識別資訊。Cloudflare 歷史 observability query API 回 403；這不是「平台沒有錯誤」的證據。事後 deployments API 確認量測期間 07:25:59.205792 UTC 有另一個 deployment，version `8172e3ac-d20d-4b39-84e3-327345f24a1b`，故此輪標記為受部署干擾。它可能導致 Object／長連線 reset，但未保存 exception 原因，無法證明因果；也不能以此解釋前兩輪第 157 筆失敗。

退休前 PostgreSQL 本輪有 53 個附件、1 個快照。Room 退休、proof 過期與清理部署之後、刪除 storage 之前，有 106 個 content receipts、56 個 management receipts，normal／security jobs 與 pending content 均為 0。這是退休後觀測，不是失敗當下的佇列佔用，不能排除瞬時容量問題。本輪 provider／DB／DO 清理及 exact module／bindings 還原通過，正常 version `ef80133d-4b37-416e-884c-c5c9b6abe3e5`；runtime、journal、lock 已移除。

測量工具接著補上 snapshot HTTP status、固定文句的 platform exception 分類與 outcome 計數；部署 guard 比較建立 fixture 前與清理前的 Worker deployment identity，變更或無法核對時 gate 一律 false。它不觀測 web deployment，也不證明 exception 的 fixture 歸屬。既有報告必須先保留到新檔名，工具會在建立 fixture 前拒絕覆寫。重跑時先 local commit 工具，待既有自動部署完成，量測與清理／還原結束後再 push main，避免此次 push 觸發部署干擾；不用改方案、環境或 DB schema。


### 穩定 Worker 部署下的 presign 500（2026-10-08）

第四輪工具與證據先 local commit（measurement commit `1c6c12d`），量測／清理／還原結束前不 push。`docs/performance/collaboration-production-3a-http2-presign-incomplete.json` 保存 20 warmup＋152 formal 完整資料：第 153 筆 presign HTTP 500，owner socket 仍為 OPEN。建立 fixture 前與清理前 deployment identity 相同，沒有本輪期間的 Worker 部署變更；web deployment 未獨立觀測，仍不能宣稱整個平台版本固定。此輪 completed／gatePassed 均 false，不合併前幾輪樣本或覆寫原 gate。

| 完成樣本（ms） | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| 保存（附件＋快照） | 3,291.87 | 4,966.48 | 9,318.52 | 9,661.47 |
| 加入（完整恢復＋fanout） | 3,564.84 | 4,818.70 | 5,230.96 | 8,344.10 |
| Presign | 527.50 | 1,133.98 | 3,775.89 | 5,359.35 |
| Snapshot 保存 | 1,151.16 | 1,799.79 | 2,036.65 | 7,643.58 |
| 首次附件下載 | 1,001.91 | 1,373.31 | 1,398.08 | 1,592.11 |

最後一筆完整保存 9,661.47 ms，snapshot 7,643.58 ms，其中 Gateway→DO 7,333 ms、DO handler 7,008 ms、registration DB 2,243.46 ms、snapshot DB write 4,176.52 ms。這證明該筆延遲有明顯 DB 區段，但不能認定下一筆 presign 500 同樣由 DB 造成，亦不能將時段差異全歸因於 HTTP/2。

Live tail 收到 2,254 個事件，0 platform exception；tail 可能漏送／抽樣，沒有收到 exception 不代表平台沒有錯誤。Vercel 既有 CLI 登入可用；CLI 62.0.0 在 08:00–08:03 UTC 的 bounded query 找到 `/api/uploadthing` HTTP 500，沿同一 request 展開仍是空 message、0 application logs。沒有保存 raw logs 或 request identifier；目前無法從該紀錄定位 DB／授權／provider 的實際錯誤。清理後 UploadThing totalBytes 295,807,706／limitBytes 1,861,758,696，當時儲存未滿；不是 failure-time 用量，也不排除其他 provider 限制。

退休前本輪 173 assets、1 snapshot；退休／proof 過期／清理部署後，346 content receipts、177 management receipts，normal／security jobs 與 pending content 全為 0，不能當作 failure-time queue occupancy。Provider／DB／DO 清理與 module／bindings 精確還原通過，正常 version `3cdd6436-5fed-4292-9558-c3a1b79c6b43`；再次唯讀核對測試前綴帳號、Room、附件、快照、tombstone、registration、creation fence、lifecycle subject 全為 0。暫存 runtime／journal／lock 移除。

工具再補非 200 presign 的 bounded response 分類：最多讀 64 KiB，只保存固定 SDK message 類別、允許的 Vercel error code、UploadThing version 是否吻合與封閉 Server-Timing 欄位，不保存 error message／SQL／URL／response body。依 lockfile 對齊的 UploadThing 7.7.4 source，預設 error formatter 只回 message，不含 code；`Failed to run middleware` 可對應 `middleware-failed`，不能把沒收到 error code 誤當成未知 SDK 版本。此新增分類已通過隱私／大小上限檢查，尚未在正式環境失敗回應驗證。

下一步先取得 presign 500 的安全回應分類與 web session／identity／Gateway 錯誤區段，並以相同測量契約的預設 HTTP transport 作對照，避免先把 HTTP/2 工具的特定行為判成產品根因。確認原因後再做產品修正及完整 200 筆 gate。功能失敗與效能超標仍存在，不能只放寬門檻；跨日／閒置／成本及其他 P3 scope 仍待驗收。本輪沒有 DB push／migration、方案／region 變更。


### 預設 transport 對照與 keepalive 補齊（2026-10-08）

`collaboration-production-3a-transport-control-incomplete.json` 保存相同 20 warmup／200 formal 契約的 Node 預設 fetch 對照，未設定 HTTP/2 dispatcher。完成 144 筆後，第 145 筆 callback `written`、snapshot／附件恢復成功，fanout 時 owner socket 1006，guest 仍 OPEN。完成樣本 save p95／p99 5,019.64／7,805.21 ms，join p95／p99 4,803.65／6,666.47 ms；completed／gatePassed false。Worker deployment 前後相同，web alias 的人工前後核對亦相同，但不是持續觀測。不能據此證明斷線根因，也不能把失敗限定為 HTTP/2 行為。

Live tail 收到 2,251 events、0 platform exception；未收到不代表無錯誤。退休前 166 assets／1 snapshot，退休後 normal／security jobs 與 pending content 全零；此計數不是 failure-time occupancy。Provider／DB／DO 清理與 exact module／bindings 還原通過，正常 Worker version `1abb2c23-454e-4c5b-9e57-9fb1ef870226`；runtime／journal／lock 已移除。

程式核對發現 shared transport 未送出既定的 15 秒 keepalive，Worker 已設定 byte-exact auto-response。現已補 client 在 joined 後送出 keepalive，disconnect、remote close、protocol failure 與 close 都清除 timer；送出失敗回報 transient，ACK 可省略、不作失敗判定。此訊息不經 crypto、不算 room activity、不延長 idle deadline。測量工具同步加入相同 keepalive 與安全的送出／ACK 計數，仍保留 5 秒 presence 以符合原 hot-DO 情境；不重試失敗樣本或修改 SLO。Transport lifecycle 測試已通過；是否改善正式環境斷線及完整 gate，必須由下一輪實測判定。


### 保活後的完整 200 筆對照（2026-10-08）

`collaboration-production-3a-transport-control.json`（commit `4f7172b`）在 09:10:30–09:40:16 UTC 完成 20 warmup＋200 formal，功能 failures 0、keepalive sent／ACK 118／118，通過前幾輪第 145／153／157 筆的位置。這證明本輪 Node harness 的保活與完整流程成功，並不證明先前 1006／presign 500 的全部根因，也不包含新版 web UI 實際操作驗收；client lifecycle 由 shared transport 測試驗證。

| 完整樣本（ms） | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| 保存（附件＋快照） | 3,874.12 | 4,916.57 | 6,048.45 | 7,545.12 |
| 加入（完整恢復＋fanout） | 3,761.81 | 4,472.73 | 5,142.71 | 9,061.08 |
| Presign | 459.08 | 759.30 | 1,668.82 | 3,291.07 |
| PUT＋callback receipt | 2,010.64 | 2,457.43 | 3,069.20 | 3,478.33 |
| Snapshot 保存 | 1,325.81 | 1,786.90 | 2,163.59 | 3,168.29 |
| 首次附件下載 | 1,721.46 | 1,979.69 | 3,081.77 | 6,664.37 |

原 save p95 3,000／p99 8,000、join p95 3,000／p99 5,000 ms 門檻保持，`gatePassed=false`：保存 p95、加入 p95／p99 超標。最慢加入第 93 筆的 9,061.08 ms 中，附件下載 6,664.37 ms（headers 5,789.13 ms）；最慢保存第 69 筆 7,545.12 ms，presign 3,291.07 ms、PUT＋receipt 2,914.05 ms、snapshot 1,335.49 ms，web route upload handler 285.66 ms。不能把 presign client 剩餘時間全歸給特定 provider／網路，也不能把不同區段的 p95 相加。下一個效能 scope 優先核對產品 join 的可並行區段與 provider／網路往返，維持 free／sea1，仍不放寬 SLO。

量測結束的 automated deployment guard 查詢失敗，原報告保留 `workerDeploymentUnchanged=null`，不回填或改 gate。清理後刷新 Wrangler credential，再查 deployments history：量測前最後 deployment 09:01:22.002850 UTC、第一個後續 deployment 為 09:41:54.550680 UTC 的本輪 cleaner，時段內無 deployment；補充記錄在 `postRunWorkerDeploymentHistory`。這是事後 Worker 歷史核對，web alias 僅事後觀測，不能證明整個平台持續固定。工具已在長測量後核對部署前重新取得 Wrangler credential，失敗時保留 initial deployment ID 與固定 HTTP status，不記 token／原始錯誤；本輪的 guard 失敗未保存狀態，不能斷言就是 token 過期。

Tail 3,039 events、0 platform exception，仍有漏送／抽樣限制。退休前 221 assets／1 snapshot；退休後 content receipts 442、management receipts 225，normal／security jobs／pending content 全零，不是 failure-time occupancy。Provider／DB／DO 清理與正常 Worker exact module／bindings 還原通過，version `69902896-cc99-4b5c-a8b6-1cfea9f82c8b`。另行唯讀核對測試前綴 user／room／asset／snapshot／tombstone／registration／creation fence／lifecycle subject 全零；runtime／journal／lock 已移除。完整 `pnpm check` 通過；沒有 DB push／migration、方案／region 變更。P3 仍待效能門檻、3B／3C、跨日／閒置／成本及完整回歸結案。


### 多圖片加入的漸進載入（2026-10-08）

核對產品加入路徑後，durable／peer baseline 已競速，附件 ID 必須由解密後的元素取得；registration 是退休屏障的一部分，不能為了減少延遲略過它。找到的前端等待是同一 lookup 的所有附件下載完才一次交給畫布，慢圖片拖住已完成圖片，且已解密檔案留到整批結束。

改為 store-wide 的有界交付佇列：最多四張立即交付，否則合併 32 ms；lookup 完成時交付剩餘圖片，destroy 取消 timer 並釋放待交付資料。維持原四個共享 transfer slots、去重、世代檢查、重試與不可讀判定。現有真實 crypto 的附件測試涵蓋慢下載仍 pending 時快圖片先顯示、32 ms 合併窗口、destroy 後不交付，以及重疊 lookup 的共享 transfer／交付上限。

此輪改善多圖片的首次可見時間與中間資料保留，不是單張附件的完整 join latency 修復；沒有重跑相同單張圖片的 200 筆或更改舊 gate。此輪未建立 production fixture，亦未改 DB／provider／Worker runtime。P3 效能仍未結案；下一 scope 應針對原完整量測的 provider／網路區段與保存往返做可驗證改善。

本輪完整 `pnpm check` 通過，附件測試 35／35、web 測試 912／912；僅保留現行測試與長期契約文件，暫存檢查日誌已移除。
