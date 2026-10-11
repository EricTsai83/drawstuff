# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以 [`docs/`](../docs/) 為唯一來源；已完成／接受延期的理由與證據保留於 docs 與 git history，不維護歷史狀態表。

## 目前前提（2026-10-10）

plan 21 已於 2026-10-10 合併部署並完成正式驗收：protocol 7、共編房間不加密（只有分享連結維持端對端加密）、Google 文件式存取（擁有者＋邀請名單＋一般存取權），房間列表分「我擁有的與受邀的」與「透過連結開啟過」兩區。一次性的共編資料清除已完成，程序與執行紀錄見 [共編 DO 部署 runbook §6](../docs/operations/collaboration-do-deployment.md)；契約見 [共編授權](../docs/architecture/collaboration-authority.md)。18B 的證據與結案決定見 [18B 重置紀錄](../docs/deployment/collaboration-reset/README.md)（歷史）。

同一正式環境供開發與驗收使用，只建立限定 fixture，保留個人場景、分享、發布、Library 與附件。plan 21 的共編資料清除是擁有者決定（D5）的一次性例外，已執行完畢；之後不得將「可整批重置」的前提套用到真實內容。測試前準備清理方案，完成後清理 provider／DB／DO 並精確還原設定；本輪不要求 DB push／migration。

已保存代表當前內容已持久成功；未確認修改在瀏覽器退出後可能遺失。快照在 Neon、圖片在 UploadThing，DO 不暫存完整畫布。房間圖片與個人場景圖片一樣是 public URL，已知 URL 無法收回，接受範圍見 [ADR-0005](../docs/adr/0005-public-collaboration-assets.md)；只有分享連結維持端對端加密。

## Active plans

目前沒有 active plan。

## 執行順序與交接

18D 已於 2026-10-12 結案，延後的效能與跨日／閒置／成本項目見 [18D 結案](../docs/deployment/collaboration-reset/README.md#18d-結案2026-10-12)；之後重現功能缺陷時另開 plan。監控／告警已接受延期，缺口見 [observability 契約](../docs/observability/collaboration-do-observability.md)。

驗證分層見 [授權契約](../docs/architecture/collaboration-authority.md#驗證分層與後續使用)：本機產品／Worker 測試不替代真實 PostgreSQL 鎖競態或正式平台驗收。

## Completion rule

1. 已實作變更完成必要驗證與 repo-level `pnpm check`；未完成的正式驗收不能寫成通過。若擁有者明確接受限制或延期，記錄決定、證據及剩餘 scope 的後續 plan，再收尾原 plan。
2. 實作現況與長期 invariant 更新到 `docs/`，修正 source／docs inbound references。
3. 移除已收尾的 plan，不在 `plans/` 留 completion evidence 或歷史副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
