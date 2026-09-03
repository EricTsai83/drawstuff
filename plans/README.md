# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## Active plans

Durable Object migration series（plans 09–15）已全數完成：production routing 無條件
DO-only，Node relay infrastructure 已退役刪除。現況與長期 invariant 見
[collaboration system design](../docs/architecture/collaboration-system-design.md)、
[DO 部署 runbook](../docs/operations/collaboration-do-deployment.md) 與
[collaboration SLO 文件](../docs/performance/collaboration-slo-capacity.md)；遷移決策見已標為
Superseded 的 [ADR-0002](../docs/adr/0002-collaboration-durable-object-target.md)，完成證據在 git
history。

- [17-collaboration-operations-follow-ups.md](17-collaboration-operations-follow-ups.md) —
  Cloudflare alerts／dashboards 依已核准定義配置，以及 relay 主機（pm2、reverse proxy、
  DNS、host secrets）拆除；全部是 repo 之外的營運操作

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、
   `pnpm knip`；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
