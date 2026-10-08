# 共編授權、儲存與退休契約

- 狀態：已實作並部署 protocol 6；2026-10-08 依擁有者決定收尾 18B。
- 驗收證據與結案決定：[部署 runbook](../deployment/collaboration-reset/README.md)。
- 未完成驗收與疑慮：[後續排查 plan](../../plans/18d-collaboration-acceptance-follow-ups.md)。

18B 的授權／資料模型與重置工作已交付。結案接受已記錄的延遲與驗證限制，不代表原 P3 全項通過或產品沒有 bug。後續產品流程由 [18C](../../plans/18c-collaboration-surface.md) 執行，不因效能排查無限延後。

## 房間與權限

Room Durable Object 的 SQLite 是房間權限唯一權威；PostgreSQL 保存加密快照、附件記錄、儲存屏障與列表投影。列表投影不是授權來源。Protocol-6 identity proof 只證明身分，不授予角色；受控入口必須檢查當前 Room 權限、世代與 lifecycle 登記。

房間可不關聯 scene，使用 initializing／ready／ended 狀態。Active 房間不因保留期自動結束；ended 房間依清理寬限期回收。Join proof 的到期時間與房間保留無關。Owner 專用初始化入口確認加密快照及宣告附件後才能 ready；一般成員不得繞過初始化。重試保留相同 operation ID，取消／退休後晚到 finalize 不得復活房間。

允許清單信箱只 trim／lowercase，不消除 dot／plus；可加入尚未註冊的信箱。信箱與比較鍵屬服務端 metadata，不得寫入 logs／analytics。撤權與允許清單移除決定不因 crypto generation 改變而消失。

## 保存與撤權

`authRevision` 是房間授權版本，`authorityEpoch` 是持久儲存 fence，`authGeneration` 是加密世代，snapshot revision 是內容版本；不能互相替代。普通踢人不自動輪替金鑰。

撤權先在 DO 本地阻擋活動，再確認外部儲存屏障；未確認時為 pending，只有完成協定才能表示 enforced。投影落後是 projectionPending，不得用來繞過權限。

Snapshot 使用 binary 密文傳輸。寫入／取消／fence 依同房間 PostgreSQL row lock 排序，去重結果與快照同交易 commit，expectedRevision 拒絕覆蓋新版。重送保留原 metadata／checksum／密文；reset 保留 revision 高水位。DO 僅保存小型操作 metadata／結果，不暫存完整畫布。回應遺失可查詢原操作；無 payload 的未完成操作必須能由 fence 終止。

「已保存」必須是當前修改及附件已獨立確認持久成功，不能以 socket ACK、pending、上傳 attempt 結束或個人副本成功替代。細節見 [儲存 UX 契約](collaboration-storage.md) 與 [ADR-0006](../adr/0006-collaboration-storage-barrier.md)。同一 session 可重連與重送離線修改，但未保存時關閉／reload 不保證保留。

附件維持 public 密文物件；撤權拒絕新的索引／上傳／finalize，無法收回已知 URL、金鑰或下載副本。接受範圍見 [ADR-0005](../adr/0005-public-collaboration-assets.md)。維持 UploadThing 免費方案／sea1，未授權升級或搬移。

## 帳號與 scene 退休

Lifecycle DO 按主體協調退休，先凍結登記與授權、確認撤權／儲存屏障，再允許 parent deletion／cascade。本人、管理員與 scene 刪除入口走同一協定，沒有直接 cascade 旁路。缺少 source scene 的房間也必須登記並可退休。

原 request 消失後 durable alarm 繼續工作；結果以 operation ID 查詢，late proof／callback／write／rejoin 不得復活被退休主體。舊 DB 權限 writer、control outbox、drain route 與 minute cron 已移除。個人場景、分享、發布與 Library 的生命週期仍須與共編隔離。

## 驗證分層與後續使用

- 本機產品／React hook：重連狀態機、離線收斂、保存狀態、金鑰／UI 分支。
- PGlite／Worker runtime：SQL 行為、DO／alarm／WebSocket 與協定。
- 真實多連線 PostgreSQL（L2″）：鎖、fence 與並行競態；不得以 mock 取代。
- 正式環境（L3）：真實 provider、部署後流程、多裝置、延遲、跨日、閒置與成本；本機測試不能替代。

已通過的測試證據及尚未證明的限制以 runbook 與後續 plan 為準。18C 的列表、初始化、金鑰及加密告知依本契約實作，仍須完成自己的正式使用流程驗收。
