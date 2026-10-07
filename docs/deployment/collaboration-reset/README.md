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
