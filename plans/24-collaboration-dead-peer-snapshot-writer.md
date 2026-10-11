# 24 — 靜默斷線的連線阻擋房間快照寫入

- 狀態：待決定；2026-10-12 於 18D 正式瀏覽器驗收發現，證據見 [18D 結案](../docs/deployment/collaboration-reset/README.md#18d-結案2026-10-12)。
- 範圍：`apps/collaboration-do`（liveness 判定與 alarm 排程）或 `apps/web` 的快照寫入者選舉；不改協定版本以外的契約須另行核對。

## 問題

斷線但沒有送出 close frame 的連線會留在 room Object 的成員名單，直到 lazy liveness 判定移除它：門檻 65 秒，且只在下一個 alarm、fanout 寫入失敗或滿員加入時檢查（[SLO §9.2](../docs/performance/collaboration-slo-capacity.md)，為了不抵銷 hibernation 的既有設計）。快照寫入者由名單中可編輯、peerId 最小者擔任（`electSnapshotWriter`）；死連線當選時，房間的耐久保存停到它被移除，其他成員每 30 秒看到「Save failed」。房間沒有其他活動時，下一個 alarm 可能是 idle 期限（約 15 分鐘）。即時同步與離開時的強制寫入不受影響。

正式驗收中 guest 每次重連，owner 看到的成員就多一個，60 秒內未減少；保存故障步驟排在斷線之後的幾輪，90 秒內沒有任何快照寫入。

## 選項

1. **Room Object 依 liveness 期限排 alarm**：有成員時，把下一次 alarm 排在最早的 liveness 期限（約 65 秒）。死連線在有界時間內移除；代價是有人在房內時 Object 約每分鐘被喚醒一次，DO duration 增加，需對照 [SLO §9 hibernation](../docs/performance/collaboration-slo-capacity.md) 與免費額度估算。
2. **Client 端後備寫入**：保存請求在一個 cadence 內沒有寫入時，提出請求的可編輯者自行寫入（與離開時的強制寫入相同，仍經角色、baseline 與條件 revision 檢查，衝突時合併）。不增加伺服器喚醒；需處理多人同時後備的衝突次數。
3. **只在名單變化時順帶檢查**：維持現狀，接受最長約 15 分鐘的保存停頓，並在 UI 說明。

4. **根本解法：改為伺服器權威**：由 room Object 持有畫布並負責持久化，不再依賴 client 存活與選舉；需要新協定版本、合併邏輯搬到伺服器與資料遷移。取捨與效能比較見 [共編的權威拓撲](../docs/system-design/collaboration-authority-topologies.md)。

## 完成條件

選定方案並記錄理由；修正有本機測試（死連線當選時仍能在有界時間內寫入）與正式驗收（`pnpm collab:browser:remote` 移除保存故障步驟的順序依賴）；文件與 `pnpm check` 通過。
