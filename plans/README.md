# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## Active plans

1. [Operator data retirement](./operator-data-retirement.md) — `Ready`。提供 scene、room、account
   三種 admin 清理能力，完整沿用現有 object、room 與 relational lifecycle。
   Operator retirement 仍是公開測試前置。
2. [Workspace 管理 Overlay Routing](./workspace-overlay-routing.md) — `Ready`。以 persistent Canvas
   layout、單一 `@overlay` slot 與多個 canonical/intercepted destination 統整 Dashboard、
   Workspace Create／Settings，並守住刪除目前 Canvas workspace 的 session lifecycle。

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、
   `pnpm knip`；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在兩份工作都完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
