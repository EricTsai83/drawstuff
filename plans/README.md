# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## Active plans

以下是一個有順序的 Durable Object migration series。除非前一個 plan 的完成條件明確成立，
不得把後一個 plan 的 production traffic gate 打開；可以提前做 read-only research，但不能提前
建立第二條 live routing path。

1. [08-collaboration-base64-codec.md](08-collaboration-base64-codec.md) — canonical Base64 codec、
   browser／Node／workerd contract、token vectors與4 MiB snapshot效能門檻
2. [09-collaboration-do-architecture-foundation.md](09-collaboration-do-architecture-foundation.md) —
   Vercel/Worker/DO權責、SQLite namespace、environment與thin gateway；production traffic 0%
3. [10-collaboration-do-room-runtime.md](10-collaboration-do-room-runtime.md) — Hibernatable
   WebSockets、attachments、Alarm、opaque fanout與Node protocol parity
4. [11-collaboration-do-durable-control.md](11-collaboration-do-durable-control.md) — typed RPC、SQLite
   revocation cutoffs、idempotent room lifecycle與storage cleanup
5. [12-collaboration-do-verification-capacity.md](12-collaboration-do-verification-capacity.md) —
   workerd/staging conformance、observability、load、latency、Hibernation與cost Go/No-Go
6. [13-collaboration-do-provider-coexistence.md](13-collaboration-do-provider-coexistence.md) —
   provider-pinned雙軌、server-owned routing與durable PostgreSQL control outbox
7. [14-collaboration-do-production-cutover.md](14-collaboration-do-production-cutover.md) — synthetic、
   internal、1/10/25/50/100% new-channel rollout、rollback gates與Node自然排空
8. [15-collaboration-do-retirement.md](15-collaboration-do-retirement.md) — 刪除Node relay、provider
   abstraction與migration config，收斂為Durable Object-only realtime architecture

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、
   `pnpm knip`；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
