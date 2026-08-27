# 15 — Legacy Node relay infrastructure retirement

- 前置：[Plan 14](./14-collaboration-do-production-cutover.md) production soak 完成
- 後續：無
- Production traffic：**100% Durable Object**

## 目標

移除 direct cutover 後已無 runtime consumer 的 Node relay package、process、reverse proxy、
DNS、secrets 與 historical operations docs。Application routing、schema 與 outbox 在 direct cutover 後已是
DO-only；本 plan 不再執行 provider migration。

## P1 — Retirement preflight

- production 已跨完整 lifecycle 且 Node metrics/control traffic 持續為 0；
- global search 沒有 runtime 參照 Node URL、PM2 process 或 relay control endpoint；
- Cloudflare Worker 有已知良好 version 與 rollback runbook；
- owner 接受退役後不可藉由 env 切回 Node。

## P2 — Infrastructure cleanup

- 移除 `apps/collaboration-relay`、`ws`、PM2 config、scripts 與 workspace references；
- 停止 Node process，移除 reverse proxy route、DNS、host/port/log/RSS/drain/watchdog secrets；
- operations、observability、SLO 只保留 DO current runbook；歷史證據留在 git history；
- 保留 provider-neutral protocol、close codes、conformance vectors 與 durable outbox。

## 完成條件

- global search 無 active Node runtime/deployment references；
- fresh room 與完整 lifecycle 仍在 production-like 環境通過；
- package/repo lint、typecheck、test、knip、build 全過；
- production smoke、dashboards、alerts、outbox 與 cost signals 正常；
- 最終 invariants 寫入 `docs/`，修正 inbound references 後依規則移除 Plans 13–15。
