# 22 — Admin 異常檢視與帳號移除的完整清除

- 狀態：需求草案（2026-10-10）；前置已完成，可排程，細節與擁有者決定待確認。
- 前置：plan 21 已完成並於 2026-10-10 部署（房間不加密、Google 文件模式存取、DO 釋放儲存、durable 工作放棄規則；見 [共編授權契約](../docs/architecture/collaboration-authority.md)、[DO 部署 runbook §6](../docs/operations/collaboration-do-deployment.md)）。與 [17](17-collaboration-operations-follow-ups.md) 的長期 logs／metrics／告警協調：本 plan 只做 admin dashboard 內可查的異常，不建外部告警設施。
- 目的：管理員能在 admin dashboard 看到需要介入的異常；移除使用者後，他的資源與個資清除乾淨。

## 0. 為什麼要做

21 讓 DO 在房間結束後釋放儲存、durable 工作 24 小時後放棄，退場（lifecycle）工作則刻意永不放棄。這些機制失敗時目前只留在 Workers Logs（`authority.work_abandoned`、`adapter.delivery_failed`），管理員沒有地方看到。退場卡住時 DO 每分鐘重試一次直到修好，沒有人會知道。

admin dashboard 已有使用者列表、退場帳號、退場場景、結束房間與稽核紀錄，但只有總數，沒有異常清單。

## 1. 範圍

### 1.1 Admin 異常區塊

全部從 Neon 計算，不需要讀 Cloudflare：

| 項目 | 判斷 | 代表 | 動作 |
| --- | --- | --- | --- |
| 退場卡住 | lifecycle 紀錄已凍結、超過門檻仍未 retired | 帳號／場景資料尚未刪完 | 連到使用者；重新觸發同一退場 |
| 房間結束但 storage 未關閉 | `status=ended`、`storage_state≠ended` 超過門檻 | 結束 fence 未送達或被放棄 | 重送結束 |
| 房間卡在建立中 | 超過初始化期限仍 `initializing` | 建房中斷 | 結束房間 |
| 檔案清理失敗 | `deferred_file_cleanup` 的 `status=failed`，或 pending 但 `attempts` 過多 | UploadThing 殘留 | 重試（見 1.4） |
| 已結束房間仍有資料 | 已結束但仍有快照、圖片或投影列 | cleanup 與維護回收都沒處理到 | 執行回收 |

每項顯示數量、明細與最後發生時間；門檻與動作待確認。

### 1.2 退場卡住的告警與退避

- 同一退場持續失敗超過門檻（例如 1 小時）時記 `error` 等級的 `lifecycle.retirement_stuck` log，供 Workers Logs 查詢。
- 卡超過 24 小時後，重試間隔由 1 分鐘拉長到例如 1 小時；仍不放棄、不釋放（退場等於刪除使用者資料）。

### 1.3 帳號移除的清除範圍

- **盤點**：逐項核對退場會清掉的 DB 列、UploadThing 物件（場景圖片、縮圖、分享連結檔案、發布產物、個人 library、房間圖片）與 DO 儲存，寫成清單與測試。
- **邀請名單**（擁有者決定，2026-10-10）：退場時把該帳號的 email 從所有進行中房間的邀請名單移除，同 email 的新帳號不繼承任何邀請。需要退場流程依 email 找出房間（Neon 邀請投影）並對各房間 DO 執行移除。
- 退場後只保留不含使用者內容的最小紀錄（lifecycle 紀錄、creation fence、登記與投影墓碑），並在文件列出。

### 1.4 檔案清理失敗的退避與重試

- **現況**：drain 只撈 `status=pending`，`failed` 列之後永遠不再處理，物件留在 UploadThing；目前 admin 的 Pending cleanup 也不計入 `failed`。失敗資料都保留在列上（`lastError`、`attempts`、`reason`、`context`、`updatedAt`），但單筆失敗不寫 log，只能直接查 DB。
- **退避太短**：`rescheduleDeferredCleanup` 為 1s 起跳指數退避、上限 60s，5 次重試約 31 秒就用完，而單次 drain 預算 60 秒，同一輪內會反覆撈到同一筆。UploadThing 短暫故障半分鐘就可能把一批檔案永久標成 `failed`。改為分鐘起跳、上限數小時（數值待確認），讓暫時性故障跨多次維護執行重試。
- **轉為 `failed` 時**記 `error` 等級的 `cleanup.deferred_failed` log（key、reason、lastError）。drain 跑在 web 維護排程，不在 Workers，所以這筆 log 會在 web 伺服器的 log 裡。
- **Admin 明細**：列出 key、reason、context、attempts、lastError、最後失敗時間。
- **重試動作**：把該列改回 `pending`、`attempts` 歸零、`nextAttemptAt=now`，由下一次 drain 處理；支援單筆與全部重試。

## 2. 待確認

- 各異常的門檻與 dashboard 上的動作。
- 「重新觸發」類動作是否需要稽核與二次確認。
- 1.4 的退避起點、上限與重試次數。
