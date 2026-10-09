# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以 [`docs/`](../docs/) 為唯一來源；已完成／接受延期的理由與證據保留於 docs 與 git history，不維護歷史狀態表。

## 目前前提（2026-10-10）

正式環境仍是 protocol 6 的加密房間（Room DO 授權權威、Lifecycle 退休已部署）。plan 21（protocol 7、房間不加密、Google 文件式存取）程式已在 `plan-21` 分支完成，尚未部署：部署時依 §7 清除所有共編資料並 DB push，程序見 [共編 DO 部署 runbook §6](../docs/operations/collaboration-do-deployment.md)。`docs/` 描述的是 plan 21 合併部署後的系統；契約見 [共編授權](../docs/architecture/collaboration-authority.md)。18B 的證據與結案決定見 [18B 重置紀錄](../docs/deployment/collaboration-reset/README.md)（歷史）。

同一正式環境供開發與驗收使用，只建立限定 fixture，保留個人場景、分享、發布、Library 與附件。plan 21 的共編資料清除是擁有者決定（D5）的一次性例外；之後不得將「可整批重置」的前提套用到真實內容。測試前準備清理方案，完成後清理 provider／DB／DO 並精確還原設定；除 plan 21 外，本輪不要求 DB push／migration。

已保存代表當前內容已持久成功；未確認修改在瀏覽器退出後可能遺失。快照在 Neon、圖片在 UploadThing，DO 不暫存完整畫布。房間圖片與個人場景圖片一樣是 public URL，已知 URL 無法收回，接受範圍見 [ADR-0005](../docs/adr/0005-public-collaboration-assets.md)；只有分享連結維持端對端加密。

## Active plans

- [17-collaboration-operations-follow-ups.md](17-collaboration-operations-follow-ups.md) — 長期 logs／metrics、client telemetry、告警與 dashboard；暫緩實現，目的地未定。
- [18d-collaboration-acceptance-follow-ups.md](18d-collaboration-acceptance-follow-ups.md) — 待排程：自然斷線／presign 500、正式瀏覽器恢復與保存狀態、效能 3A／3B／3C、跨日／閒置／autosuspend／成本及剩餘回歸。先定位再重測，一次一個 scope，不阻擋 21。
- [21-plain-rooms-google-docs-access.md](21-plain-rooms-google-docs-access.md) — 共編房間改為不加密（只有分享連結維持端對端加密），存取改為 Google 文件模式（擁有者＋邀請名單＋一般存取權），房間列表分「受邀」與「透過連結開啟過」兩區；清除現有共編資料。取代已刪除的 18C 剩餘驗收、19、20。第 1～3 批已在 `plan-21` 分支完成，待第 4 批（資料清除與部署）。
- [22-admin-anomalies-and-account-removal-cleanup.md](22-admin-anomalies-and-account-removal-cleanup.md) — admin dashboard 異常檢視（退場卡住、storage 未關閉、清理失敗等）、退場卡住告警與退避、帳號移除的完整清除盤點與邀請名單移除。需求草案，21 合併後排程。

## 執行順序與交接

21 依 §8 在 `plan-21` 分支分批實作，完成後清除資料並一次合併到 main。18D 暫時保留作後續排查，不因索引更新自動啟動全部長測；重現功能缺陷時優先處理其穩定性 scope，純延遲超標依已接受限制排程。需要持續觀測設施時與 17 協調。

驗證分層見 [授權契約](../docs/architecture/collaboration-authority.md#驗證分層與後續使用)：本機產品／Worker 測試不替代真實 PostgreSQL 鎖競態或正式平台驗收。

## Completion rule

1. 已實作變更完成必要驗證與 repo-level `pnpm check`；未完成的正式驗收不能寫成通過。若擁有者明確接受限制或延期，記錄決定、證據及剩餘 scope 的後續 plan，再收尾原 plan。
2. 實作現況與長期 invariant 更新到 `docs/`，修正 source／docs inbound references。
3. 移除已收尾的 plan，不在 `plans/` 留 completion evidence 或歷史副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
