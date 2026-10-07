# 18B P3 維護窗口與回滾

這是待執行清單。P2／P3 的寫入演練只使用隔離 workerd 與本機 PostgreSQL；另已完成 production 唯讀核對，尚未修改 production DB、secret、cron 或部署。production 目前仍使用 protocol 5。web、Worker 與 schema 必須配套切換；自動部署若未暫停，維護窗口中不要 push `main`。

## 已準備的 artifact

- `upgrade.sql`：清空共編表後建立目前 schema。
- `rollback.sql`：清空新版共編表後恢復 protocol-5 共編 schema；以 `c6f2044` 為基礎並依 2026-10-07 production 唯讀核對校準。程式也必須配套為 protocol 5。
- `manifest.sql`：唯讀匯出密文 object key 與已知舊 DO 名稱；排除個人附件、縮圖、發布成品。
- `pnpm --filter @drawstuff/web collaboration:reset-plan`：再生 SQL，**不連資料庫**。
- `collaboration:reset-check`：在 PostgreSQL repeatable-read／read-only 交易中核對共編表名、欄位、型別與 nullable；記錄索引／constraint、舊物件清單及所有非共編 `public.drawstuff_*` 表的筆數／內容指紋。`after` 必須與同一 endpoint 的 `before` 比對一致。索引、constraint、default 仍須人工對照 SQL，工具不宣稱完整 schema 相容性。
- `wrangler.maintenance.jsonc`：同名 Worker、原 Room namespace；一般 HTTP 入口回 503，僅私有 quiesce 入口可批次確認停止；無 cron，DO 啟動時取消 alarm、關閉 hibernated socket。**保留 SQLite／KV，不是清除工具。**
- `quiesce`：使用 authority capability 依 manifest／namespace inventory 批次喚醒舊 DO，逐一確認維護 runtime 已接手；取消 alarm、關 socket，保留 storage。
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

`cf:loadtest` 是 30 次最大快照讀取樣本。真實 UploadThing 上傳／callback、三人 fanout、scene／帳號退休、故障恢復、join／保存／撤權 p95/p99、跨日重進、Neon autosuspend 與成本仍依 [18B §9](../../../plans/18b-collaboration-authority-reset.md#9-驗收矩陣) 記錄 L3；pending 不算完成。確認個人場景、分享、發布、Library 與附件可用，smoke 通過才恢復流量與自動部署。

## 舊物件／DO 清理

先完成可回滾 smoke，再按受控 manifest 清理有明確共編來源且不被任何個人資料引用的物件。DO metadata 清理必須對已確認的舊 instance 停止工作、取消 alarm 並 `storage.deleteAll()`；本次維護程式只保留狀態，不提供公開刪除入口。**舊 SQLite 與已停止的歷史 generation 清理仍是 P3 待辦，不能稱已全刪。** 保留識別、清理狀態與重試證據，不能以「已不可達」代替完成。

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
