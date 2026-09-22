# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## 目前的前提（2026-09-23）

這批計畫的形狀由四個前提決定，任何一條改變都要重新評估：

1. **共編只有擁有者一人在用，且都是測試資料。** 共編相關資料（`collaboration_room` 與其
   cascade、`collaboration_control_outbox`、Room DO 的 SQLite 狀態、UploadThing 上的共編密文物件）
   **可以整批刪除重建**。
2. **必須保留：** 登入帳號與個人雲端場景（`scene`、`shared_scene`、published 內容）及其附件。
3. **不採用中繼解法。** 不做向後相容、不做雙寫、不做逐房間遷移。允許停機的一次破壞性重置；先隔離測試流量與舊背景寫入，
   不做混合版本相容，但保留簡短切換／回滾清單。
4. **Neon free tier 額度本月已用盡，下月 1 日恢復。** 在那之前開發是「改程式碼 ＋ 本機可跑的驗證」，
   所有需要 Neon 的動作（`db:push`、破壞性重置、production 驗收、延遲量測）標 `[L3]`，
   **在額度恢復後依清單執行**；本機多連線 Postgres 競態驗證（L2″）提前完成，
   隔日重進與閒置觀測可跨日，不能為趕日期略過驗收（分層見
   [18B §0.4](18b-collaboration-authority-reset.md)）。
   已明確否決把 cron 調慢這類中途措施：本月額度已耗盡，省不到東西，而 18B P3 本來就會刪掉那個 cron。

前提 1–3 讓原本 18 系列裡約三分之一的篇幅（漸進式 schema 約束、backfill、逐房間凍結與匯入、
authorityEpoch 過渡期、混合版本部署順序、舊 outbox 逐筆對帳）**整段消失**。
前提 4 不改變目標設計，只改變驗證順序與可宣稱的完成度。

## Active plans

Durable Object migration series（plans 09–15）已全數完成：production routing 無條件
DO-only，Node relay infrastructure 已退役刪除。現況與長期 invariant 見
[collaboration system design](../docs/architecture/collaboration-system-design.md)、
[DO 部署 runbook](../docs/operations/collaboration-do-deployment.md) 與
[collaboration SLO 文件](../docs/performance/collaboration-slo-capacity.md)；遷移決策見已標為
Superseded 的 [ADR-0002](../docs/adr/0002-collaboration-durable-object-target.md)。

- [17-collaboration-operations-follow-ups.md](17-collaboration-operations-follow-ups.md) —
  共編監控機制、logs／metrics 匯出、client telemetry、告警與 dashboard；單人使用、Vercel Hobby，
  **暫緩實現**，監控目的地未定，不綁定部署平台
- [18a-collaboration-storage-ux.md](18a-collaboration-storage-ux.md) —
  共編儲存入口的模式／目的地語意，以及房間內容與個人場景本機快取的隔離。**無前置，可立即開始。**
  修的是現況 `use-collaboration-room.ts` 以 `ownsCanvas && !currentSceneId` 判斷造成的既有行為：
  有個人 sceneId 的共編使用者，房間畫布仍會寫進個人 localStorage。
  優先保護個人草稿與恢復邊界，再完成跨成員保存確認；主要開發驗證不受 Neon 額度影響
- [18b-collaboration-authority-reset.md](18b-collaboration-authority-reset.md) —
  Room DO 成為房間授權的唯一權威、房間永不到期、帳號允許清單、房間不需要 scene、
  儲存屏障與附件授權、帳號／白板退休協定，以及一次破壞性重置。
  **P0 先驗證私有附件、最大 binary payload 與真實多連線儲存屏障**；
  DO 不持久暫存完整畫布，只記小型待辦與操作結果；初始化／可靠投影後端在本計畫完成。
  退休以按主體分割的 **Lifecycle DO** 執行（§7.1，2026-09-23 定案）；P3 需要 Neon 可用
- [18c-collaboration-surface.md](18c-collaboration-surface.md) —
  我的房間列表、本機金鑰與缺鑰體驗、未儲存畫布直接建立獨立房間，以及全產品加密狀態告知。
  依賴 18B 與 18A

### 執行順序與交接

1. 18B P0 固定可行性與故障契約，可與 18A 並行；18A 先快取隔離／恢復，再保存確認與入口。
2. P0 通過後做 18B P1／P2，包含初始化與投影後端、保存查詢／取消、撤權安全預算。
3. L1／L2／L2′／L2″ 與重置／回滾演練通過，服務可用後執行 18B P3：停寫、重置、部署、smoke、恢復入口，
   再完成其餘 L3；不要求部署後驗收在部署前完成。
4. 18C 可依固定契約提早開發 UI，但 production 開放獨立房間須等待 18A／18B 驗收與本身加密告知完成。

已保存代表內容已持久成功；未確認內容在瀏覽器退出後可能遺失。完整快照留在 Neon、圖片在 UploadThing，
DO 的 outbox 不暫存整份畫布；無 payload 的操作須能查明成功或經 adapter fence 取消，不能永遠 pending。

### 這一版與 2026-09-23 早先版本的差異

原本的 18B（房間保留期）、18C（DO 授權權威）、18D（列表／金鑰／退休）、19（獨立房間與加密告知）、
20（帳號允許清單）五份計畫，**分割線幾乎全部是漸進遷移的階段界線**。前提 3 之後那些界線不再有意義，
分開做等於自己製造一連串中繼狀態，因此重新合併為：

- **18B ＝** 舊 18B ＋ 舊 18C ＋ 舊 18D §4 ＋ 舊 19 的資料模型 ＋ 舊 20（授權與 schema）
- **18C ＝** 舊 18D §2–§3 ＋ 舊 19 的 UX 與告知（使用者看得到的表面）

連帶解掉的：舊 18D §4「必須早於舊 18C P3」這條排序死結（不再有逐房間切換階段）、舊 18C §3.1 的 DO 定址
兩案選擇（沒有狀態要交接，直接採 roomId）、舊 20 §6 的「回寫 18C P3 匯入清單」。

同時 **放棄了舊 18C §0.1 的 Cloudflare 端 pending 旗標方案**（工作區實作已於 2026-09-23 刪除）：
18B 完成後 control outbox 整個消失，那份實作 100% 拋棄式，與前提 3 衝突。

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、
   `pnpm test`、`pnpm knip`（即 `pnpm check`）；**標 `[L3]` 的驗收項未完成前不得宣稱計畫完成**；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
