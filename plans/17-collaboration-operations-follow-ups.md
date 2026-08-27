# 17 — Collaboration 營運收尾：alerts 配置與 relay 主機拆除

- 前置：無（repo 內的 DO cutover 與 relay 退役已完成；本 plan 全部是 repo 之外的營運操作）
- 後續：無

## 目標

完成 Plan 14／15 收尾時仍未完成、且只能在 Cloudflare dashboard 與自架主機上執行的兩組
營運工作。repo 內沒有對應的程式碼變更；完成證據記在本 plan 的移除 commit。

## P1 — Cloudflare alerts 與 dashboards 配置

依 [DO observability 契約](../docs/observability/collaboration-do-observability.md) §6 的
已核准定義逐條配置並驗證：

- Workers Logs 查詢／notification 建立 §6 表列的每個 alert（`DoConfigInvalid`、
  `DoInternalError`、`DoUnexpectedDisconnectRate`、`DoSlowConsumerRate`、
  `DoControlRejected`、`DoLogFieldsRejected`、`DoNamespaceErrors`、`DoOverload`），
  並確認 Workers Logs head sampling = 1（否則比率型 alert 低估）；
- §6.1 的 `collab.ratelimit.degraded`（web 端 fail-open limiter 訊號）在 Vercel log 側
  建立對應告警；
- 建立 §6 尾段列出的 dashboard 面板組；
- 每個 alert 觸發一次人工驗證（或以 log 注入驗證查詢正確）。

## P2 — Relay 主機拆除

Node relay 程式碼已自 repo 刪除且無 production traffic；主機側資源仍在：

- 停止並移除 pm2 process（`collaboration-relay`）與 pm2 開機啟動項；
- 移除 reverse proxy 的 WebSocket route 與對應 DNS 記錄；
- 移除主機上的 relay secrets／環境設定（host/port/log/RSS/drain/watchdog 相關）；
- 確認移除後 production 共編不受影響（`pnpm cf:smoke <worker-url>` 通過即可）。

## 完成條件

- §6／§6.1 每個 alert 都存在且驗證過一次；
- relay 主機無殘留 process、route、DNS 或 secrets；
- 依 plans/README 完成規則移除本 plan。
