# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## Active plans

來源：2026-08-13 全面 code review（六個範圍：跨模組架構、共用套件、relay、
協作 client、web 後端、web UI）。編號即建議執行順序。

1. [04-dashboard-ui-fixes.md](04-dashboard-ui-fixes.md) —
   dashboard/UI 修復（刪除 dialog 鎖死、filter page-walk、per-card observers 等）
2. [06-shared-packages-consolidation.md](06-shared-packages-consolidation.md) —
   sealed-envelope 去重、relay-control 契約入套件、eslint/turbo 收斂
3. [07-relay-hardening.md](07-relay-hardening.md) —
   relay exception guard、timer clamp、O(N²) broadcast 編碼
4. [08-collab-client-modularization.md](08-collab-client-modularization.md) —
   四個巨型檔案拆分 + 熱路徑效能

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、
   `pnpm knip`；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在所有工作完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
