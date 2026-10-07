# 18B P3 維護窗口與回滾

這是待執行清單。P2 的測試只使用隔離 workerd、PGlite 與本機 PostgreSQL；尚未修改 production DB、secret、cron 或部署。production 目前仍使用 protocol 5。不要直接 push `main`：既有 Workers Builds／Vercel 自動部署必須先暫停，這次 web、Worker 與 schema 要一起切換。

## 已準備的 artifact

- `upgrade.sql`：清空共編表後建立目前 schema。
- `rollback.sql`：清空新版共編表後恢復 `c6f2044` 的 protocol-5 共編 schema；回滾程式也必須配套為 protocol 5。
- `manifest.sql`：唯讀匯出密文 object key 與已知舊 DO 名稱。排除個人附件、縮圖、發布成品。
- `pnpm --filter @drawstuff/web collaboration:reset-plan`：從目前 schema 與保留的舊 fixture 再生 SQL，**不連資料庫**。
- `pnpm collab:adapters`：Docker PostgreSQL 17 上執行競態與舊 schema 重置／升版／回滾演練；核對帳號、個人／分享／發布文件、Library bytes 與附件引用完全相同。

SQL 只 DROP `drawstuff_collaboration_*`，不使用 CASCADE。若有未預期的外部 FK，交易會失敗。artifact 不會直接刪除 UploadThing 物件。重置適用於目前可丟棄的共編測試資料；開放真實使用後須重新設計。

## 執行順序

1. 保存 DB snapshot 與目前 web／Worker deployment IDs；比對 Neon 實際 schema 與 rollback fixture，確認沒有額外個人表變更。暫停自動部署、測試分頁與共編流量。
2. 停止舊 Worker minute cron；將 web 與 Worker 的所有共編、退休、維護和 UploadThing callback 入口隔離。只有關閉建房／join 的開關不足以隔離舊背景 writer。等待或終止在途 callback、舊 DO alarm，確認沒有舊服務綁定呼叫。維護頁／入口拒絕必須涵蓋 API 與 callback。
3. 執行唯讀 manifest，保存到受控位置；另記錄未落 DB 的在途上傳、歷史 generation DO 的 namespace inventory／log 證據。只刪有明確共編來源且不被任何個人資料引用的物件。先完成回滾 smoke 再清理物件較易重試。
4. 審閱 `upgrade.sql` 與實際 diff，套共編 schema。不要以未審閱的全庫 `db:push` 代替。既有帳號、scene、shared_scene、published 成品、file_record、personal_library 都保留。
5. 在隔離窗口部署配套 web／Worker，設定三個獨立 capability：`COLLAB_IDENTITY_SECRET`、`COLLAB_AUTHORITY_SECRET`、`COLLAB_ADAPTER_SECRET`；Worker 另設定 `COLLAB_ADAPTER_URL`。確認 cron 空陣列、舊 drain 404、舊 generation socket／control 404。記錄舊 DO 的清理完成狀態；仍留下不可達 SQLite 就不能稱已全刪。新版 private legacy RPC 僅供既有 runtime regression，沒有 public 路由或 web writer；隔離舊 binding caller 仍是必要步驟。
6. 維護窗口內用兩個已驗證、可測試的登入帳號跑 `pnpm cf:smoke <https-gateway-origin>`。環境須設定 `COLLAB_HARNESS_OWNER_SUBJECT/EMAIL/VERSION`、`COLLAB_HARNESS_GUEST_SUBJECT/EMAIL/VERSION`、兩個 Gateway／identity secret 與允許的 `COLLAB_SMOKE_ORIGIN`。principal 必須是 DB 真實帳號與目前 lifecycle version；工具不建立假帳號，也不刪帳號，只建立及結束測試 Room。不得將 secret 放進命令參數或輸出。
7. 工具涵蓋最大合法加密快照往返／解密、ready、正式 WebSocket、撤權關線與 end。`cf:loadtest` 是 30 次最大快照讀取樣本；細項 frame contract 在 workerd tests。UploadThing 真實上傳／callback、三人 fanout、scene／帳號退休、故障恢復、join／保存／撤權 p95/p99、跨日重進、Neon autosuspend 與成本仍依 [18B §9](../../../plans/18b-collaboration-authority-reset.md#9-驗收矩陣) 記錄 L3 證據。pending 一律不算完成。
8. 確認個人場景、分享、發布、Library 與附件可用，smoke 通過才恢復流量與自動部署。保留舊 object／DO 清理清單直到所有項目確認；沒有待辦時觀測房間授權不再周期查 Neon。

## 回滾

先停止新版流量、alarm、背景工作與 callback；保存新版共編 object／DO 清理清單。共編測試內容可丟棄時套 `rollback.sql`，恢复配套 protocol-5 web／Worker deployment 與所需舊 secrets／cron。隔離期間先 smoke 並驗證個人資料，再恢復流量。不能讓舊程式接新版 schema，也不能只回滾其中一個服務。Neon 實際 schema 不符 fixture 時應使用維護前 snapshot 或先修正 artifact，不能猜測套用。
