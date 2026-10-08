# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以 [`docs/`](../docs/) 為唯一來源；已完成／接受延期的理由與證據保留於 docs 與 git history，不維護歷史狀態表。

## 目前前提（2026-10-08）

Protocol 6、Room DO 授權權威、Lifecycle 退休及配套 web／Worker／schema 已部署。18B 依擁有者決定結案：效能未達原門檻、偶發故障根因及未完成驗收轉入後續排查；不宣稱原 P3 全項通過。契約見 [共編授權](../docs/architecture/collaboration-authority.md)，證據與結案決定見 [部署 runbook](../docs/deployment/collaboration-reset/README.md)。

同一正式環境供開發與驗收使用，只建立限定 fixture，保留個人場景、分享、發布、Library 與附件；不得將過去「只有測試資料、可整批重置」的前提套用到後續真實內容。測試前準備清理方案，完成後清理 provider／DB／DO 並精確還原設定；本輪後續不要求 DB push／migration。

已保存代表當前內容已持久成功；未確認修改在瀏覽器退出後可能遺失。快照在 Neon、圖片在 UploadThing，DO 不暫存完整畫布。Public 密文物件的已知 URL 與金鑰無法收回，接受範圍見 [ADR-0005](../docs/adr/0005-public-collaboration-assets.md)。

## Active plans

- [17-collaboration-operations-follow-ups.md](17-collaboration-operations-follow-ups.md) — 長期 logs／metrics、client telemetry、告警與 dashboard；暫緩實現，目的地未定。
- [18c-collaboration-surface.md](18c-collaboration-surface.md) — 下一個產品實作 plan：房間列表、缺鑰體驗（不保存金鑰）、未儲存畫布建立獨立房間、全產品加密告知。依已部署授權／儲存契約實作，完成自身正式流程驗收。
- [18d-collaboration-acceptance-follow-ups.md](18d-collaboration-acceptance-follow-ups.md) — 待排程：自然斷線／presign 500、正式瀏覽器恢復與保存狀態、效能 3A／3B／3C、跨日／閒置／autosuspend／成本及剩餘回歸。先定位再重測，一次一個 scope，不阻擋 18C 開發。

## 執行順序與交接

18C 可依固定後端契約開始，自己的正式使用流程驗收不能省略。18D 暫時保留作後續排查，不因索引更新自動啟動全部長測；重現功能缺陷時優先處理其穩定性 scope，純延遲超標依已接受限制排程。需要持續觀測設施時與 17 協調。

驗證分層見 [授權契約](../docs/architecture/collaboration-authority.md#驗證分層與後續使用)：本機產品／Worker 測試不替代真實 PostgreSQL 鎖競態或正式平台驗收。

## Completion rule

1. 已實作變更完成必要驗證與 repo-level `pnpm check`；未完成的正式驗收不能寫成通過。若擁有者明確接受限制或延期，記錄決定、證據及剩餘 scope 的後續 plan，再收尾原 plan。
2. 實作現況與長期 invariant 更新到 `docs/`，修正 source／docs inbound references。
3. 移除已收尾的 plan，不在 `plans/` 留 completion evidence 或歷史副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
