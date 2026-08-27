# 15 — Legacy Node relay infrastructure retirement

- 前置：[Plan 14](./14-collaboration-do-production-cutover.md) production soak 完成
- 後續：無
- Production traffic：**100% Durable Object**

## 目標

移除 direct cutover 後已無 runtime consumer 的 Node relay package、process、reverse proxy、
DNS、secrets 與 historical operations docs。Application routing、schema 與 outbox 在 direct cutover 後已是
DO-only；本 plan 不再執行 provider migration。

## P1 — Retirement preflight

- production 已跨完整 lifecycle（至少一個 `MAX_ROOM_TTL_MINUTES` 24h 窗口 + join token
  TTL）且 Node metrics/control traffic 持續為 0；
- global search 沒有 **runtime code 或 deployment config** 參照 Node URL、PM2 process 或
  relay control endpoint（docs 與程式碼註解中的歷史引用不擋 preflight，由 P2/P3 清除）；
- Cloudflare Worker 有已知良好 version 與 rollback runbook；
- owner 接受退役後不可藉由 env 切回 Node；
- 明確接受覆蓋面變化：relay 的 `protocol-conformance.integration.test.ts` 是 shared
  conformance cases 的第二個消費者，刪除後「兩實作互證」消失，只剩 DO 側驗證同一批 case。

## P2 — Infrastructure cleanup

已盤點的 workspace references，逐項移除（缺一 knip/lint 不會全部抓到）：

- `apps/collaboration-relay` 整個 package（含 `pm2.config.cjs`、runtime `ws` 與
  `@types/ws`；**注意** `apps/collaboration-do` 的 devDependency `ws` 由
  smoke/conformance-remote/loadtest scripts 使用，必須保留）；
- root `package.json` 的 `dev:relay` script；
- `eslint.config.ts` 的 relay 專屬 no-restricted-imports 區塊，以及 DO 區塊中
  `**/apps/collaboration-relay/**` 的禁令 pattern（package 刪除後成為死規則）；
- `pnpm-lock.yaml` 的 relay entry（重跑 `pnpm install` relock）；
- 跨 package 註解中的 dangling references：`packages/collaboration/src/client-pacing.ts`
  （指向 relay 的 rate-limit.ts）、`packages/collaboration/src/protocol-conformance.ts`
  檔頭、`apps/collaboration-do/tests/protocol-conformance.test.ts` 註解、
  `apps/web/tests/collaboration-server-logging-contract.test.ts` 的 relay logger 對照；
- 停止 Node process，移除 reverse proxy route、DNS、host/port/log/RSS/drain/watchdog secrets。

## P3 — Docs cutover（不是只刪除）

- **先補上取代品**：目前 `docs/` 沒有 DO deployment/restart runbook——事實上的 runbook 在
  `apps/collaboration-do/README.md`。把 deploy 矩陣、lifecycle vs code-only deploy、
  rollback 程序與 secret 管理收斂成 `docs/operations/` 的 DO runbook，取代
  `collaboration-relay-deployment.md`，再刪除舊文件；
- 逐份清理仍標 Status: Current 的 relay 內容：
  `docs/observability/collaboration-alerts-and-dashboards.md`（`relay_*` Prometheus metric
  契約）、`docs/performance/collaboration-slo-capacity.md`（單 instance／pm2 段落）、
  `docs/observability/relay-metrics-sample.txt`（整檔刪除）、
  `docs/architecture/architecture-contract.md`（relay ownership row 與依賴圖）、
  `docs/adr/0001`／`README.md` 的 inbound references；ADR-0002/0003 的歷史「現況」註記
  改為已註明過時的 amendment，不改寫決策本文；
- operations、observability、SLO 只保留 DO current runbook；歷史證據留在 git history；
- 保留 provider-neutral protocol、close codes、conformance vectors 與 durable outbox。

## 完成條件

- global search 無 active Node runtime/deployment references（判準同 P1：runtime code 與
  deployment config；docs 歷史引用已在 P3 清除）；
- fresh room 與完整 lifecycle 仍在 production-like 環境通過；
- package/repo lint、typecheck、test、knip、build 全過；
- production smoke、dashboards、alerts、outbox 與 cost signals 正常；
- 最終 invariants 寫入 `docs/`（含 P3 的 DO runbook），修正 inbound references 後依規則
  移除 Plans 14–15。
