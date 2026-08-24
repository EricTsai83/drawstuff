# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## Active plans

### Durable Object migration series

以下是一個有順序的 Durable Object migration series。除非前一個 plan 的完成條件明確成立，
不得把後一個 plan 的 production traffic gate 打開；可以提前做 read-only research，但不能提前
建立第二條 live routing path。

1. [13-collaboration-do-provider-coexistence.md](13-collaboration-do-provider-coexistence.md) —
   provider-pinned雙軌、server-owned routing與durable PostgreSQL control outbox
2. [14-collaboration-do-production-cutover.md](14-collaboration-do-production-cutover.md) — synthetic、
   internal、1/10/25/50/100% new-channel rollout、rollback gates與Node自然排空
3. [15-collaboration-do-retirement.md](15-collaboration-do-retirement.md) — 刪除Node relay、provider
   abstraction與migration config，收斂為Durable Object-only realtime architecture

系列的共同前置（canonical Base64 codec、browser／Node／workerd contract、token vectors、
4 MiB snapshot 效能門檻、Hibernatable room runtime 與 durable control plane）已完成；長期
Claims 與效能證據見
[ADR-0002](../docs/adr/0002-collaboration-durable-object-target.md) 與
[collaboration SLO 文件](../docs/performance/collaboration-slo-capacity.md) §8。
Room member/socket caps 是內部資源防護，不是 production capacity commitment；首次 production
assignment 前的 live smoke、remote conformance 與小群組 synthetic fanout 由 Plan 14 gate 執行。

### 獨立工作

與上面的 series 正交，可並行執行，順序不受 migration gate 約束：

- [16-collaboration-code-delivery-boundary.md](16-collaboration-code-delivery-boundary.md) —
  補上 threat model 缺少的 code-delivery boundary（B6／T16）、精確化 E2EE 對外宣稱，並以
  CSP `connect-src` 收斂 room key 的 exfiltration 出口；不改 protocol、crypto 或 routing

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、
   `pnpm knip`；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
