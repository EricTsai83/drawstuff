# 共編授權、儲存與退休契約

- 狀態：protocol 7；存取模型與明文房間依 [plan 21](../../plans/21-plain-rooms-google-docs-access.md)（2026-10-10）。18B 已於 2026-10-08 依擁有者決定收尾。
- 驗收證據與結案決定：[部署 runbook](../deployment/collaboration-reset/README.md)。
- 未完成驗收與疑慮：[後續排查 plan](../../plans/18d-collaboration-acceptance-follow-ups.md)。

18B 的授權／資料模型與重置工作已交付。結案接受已記錄的延遲與驗證限制，不代表原 P3 全項通過或產品沒有 bug。

## 房間與權限

Room Durable Object（`CollaborationRoomV2`）的 SQLite 是房間權限唯一權威；PostgreSQL 保存明文快照、附件記錄、儲存屏障與列表投影。列表投影不是授權來源。房間不做端對端加密：與「我的場景」相同，以登入與權限保護，傳輸由 WSS／HTTPS 加密。Identity proof 只證明身分（subject、已驗證 email、lifecycle version），不授予角色；受控入口必須檢查當前 Room 權限與 lifecycle 登記。

角色不儲存，每次檢查依序計算（Google 文件模式）：

1. 房間已結束或已被拒絕 → 無權限；initializing 房間只有 owner 可進。
2. 擁有者 → `owner`。
3. 在邀請名單上的 email → 邀請角色與一般存取權角色取較高者。
4. 一般存取權（`linkRole`）為 `viewer`／`editor` → 該角色；`none` → 無權限。

`join` 只記錄誰開啟過（subject、email、lifecycle version、`last_joined_at`），供列表與「已加入」顯示，從不寫入角色。Room 指令：`create`、`join`、`set-link-role`、`allow-email`、`remove-email`、`complete-initialization`、`cancel-initialization`、`end-room`、`leave`。`remove-email` 刪除該邀請列（不留「已移除」狀態，重新邀請即恢復；一般存取權開放時對方仍可用連結進入），且不需 adapter 註冊，web 暫時不可用時仍能收回權限。`leave` 刪除自己的邀請列與開啟紀錄，也用來從「透過連結開啟過的」列表手動移除。

權限變動後線上連線立即重算：失去存取權以 `membershipRevoked` 關閉，仍有存取但角色改變以 `roleChanged`（4015，client 重連取得新角色）關閉，房間結束以 `roomEnded` 關閉。

房間可不關聯 scene，使用 initializing／ready／ended 狀態。Active 房間不因保留期自動結束；ended 房間依清理寬限期回收。Join proof 的到期時間與房間保留無關。Owner 專用初始化入口確認快照及宣告附件後才能 ready；一般成員不得繞過初始化。重試保留相同 operation ID，取消／退休後晚到 finalize 不得復活房間。Web 建房拒絕任何用過的 roomId，因為 DO 結束後不保留墓碑：不同建立操作、已結束的房間（連原建立操作的重試也拒絕），以及只剩 creation fence 的 roomId；房間仍進行中時，原建立操作的重試照常冪等通過。

邀請名單信箱只 trim／lowercase，不消除 dot／plus；可加入尚未註冊的信箱。信箱與比較鍵屬服務端 metadata，不得寫入 logs／analytics。

## 保存與撤權

`authRevision` 是房間授權版本，`authorityEpoch` 是持久儲存 fence，snapshot revision 是內容版本；不能互相替代。只有可能收回權限的變更才推進 epoch（fence）：一般存取權收窄、編輯邀請降為檢視、移除邀請、離開、結束房間；過期 epoch 的寫入以 `epoch-mismatch` 拒絕。

撤權先在 DO 本地阻擋活動，再確認外部儲存屏障；未確認時為 pending，只有完成協定才能表示 enforced。投影落後是 projectionPending，不得用來繞過權限。

Snapshot 以 binary 明文編碼傳輸，每房間一列並帶 checksum。寫入／取消／fence 依同房間 PostgreSQL row lock 排序，去重結果與快照同交易 commit，expectedRevision 拒絕覆蓋新版。重送保留原 metadata／checksum／內容；reset 保留 revision 高水位。DO 僅保存小型操作 metadata／結果，不暫存完整畫布。回應遺失可查詢原操作；無 payload 的未完成操作必須能由 fence 終止。

「已保存」必須是當前修改及附件已獨立確認持久成功，不能以 socket ACK、pending、上傳 attempt 結束或個人副本成功替代。細節見 [儲存 UX 契約](collaboration-storage.md) 與 [ADR-0006](../adr/0006-collaboration-storage-barrier.md)。同一 session 可重連與重送離線修改，但未保存時關閉／reload 不保證保留。

附件是 UploadThing public 明文物件，暴露程度與個人場景圖片相同；撤權拒絕新的索引／上傳／finalize，無法收回已知 URL 或下載副本。接受範圍見 [ADR-0005](../adr/0005-public-collaboration-assets.md)。維持 UploadThing 免費方案／sea1，未授權升級或搬移。

## 房間列表

列表分兩區，由 DO 投影到 Neon：「我擁有的與受邀的」（`section: "mine"`）與「透過連結開啟過的」（`section: "link"`）。帳號投影以 subject 為鍵、帶 `access`（`owned`／`invited`／`link`）；邀請投影（`collaboration_room_invite`，adapter 指令 `project-invite`）以正規化 email 為鍵，讓尚未開啟過的邀請也出現在列表。同一房間的帳號列與邀請列以較新的 `projectionVersion` 決定是否列出、列在哪一區。失去存取權、離開或房間結束時投影為 tombstone。

## 資源釋放

- Room DO 的 durable 工作從第一次排程起 24 小時仍未送達即放棄（log `authority.work_abandoned`），本地紀錄收成終態，不聲稱遠端已完成。`CollaborationLifecycle` 的退場工作不放棄。
- 房間結束且 fence、cleanup 都已送達（或放棄）、沒有連線與進行中的 RPC 時，DO `deleteAll()` 並清除 alarm（log `room.storage_released`）；從未建立成功的房間同樣不留儲存。
- 完成的 Lifecycle 退場物件保留 1 小時後釋放；之後遲到的 `begin` 會冪等重跑。
- 房間結束後 Neon 只保留房間列（`status='ended'`、清空名稱）與 creation fence，用來拒絕 roomId 重用；成員／邀請投影、投影墓碑、操作紀錄與退場登記都刪除。註冊、建立父紀錄、storage fence、cleanup 與回收以 roomId advisory lock 序列化。

## 帳號與 scene 退休

Lifecycle DO 按主體協調退休，先凍結登記與授權、確認撤權／儲存屏障，再允許 parent deletion／cascade。本人、管理員與 scene 刪除入口走同一協定，沒有直接 cascade 旁路。缺少 source scene 的房間也必須登記並可退休。

原 request 消失後 durable alarm 繼續工作；結果以 operation ID 查詢，late proof／callback／write／rejoin 不得復活被退休主體。個人場景、分享、發布與 Library 的生命週期仍須與共編隔離。

## 驗證分層與後續使用

- 本機產品／React hook：重連狀態機、離線收斂、保存狀態、沒有權限等 UI 分支。
- PGlite／Worker runtime：SQL 行為、DO／alarm／WebSocket 與協定。
- 真實多連線 PostgreSQL（L2″）：鎖、fence 與並行競態；不得以 mock 取代。
- 正式環境（L3）：真實 provider、部署後流程、多裝置、延遲、跨日、閒置與成本；本機測試不能替代。

已通過的測試證據及尚未證明的限制以 runbook 與後續 plan 為準。Plan 21 的存取、列表與明文儲存仍須完成其驗收矩陣的正式使用流程驗收。
