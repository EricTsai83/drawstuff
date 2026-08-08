# Active work

`plans/` 只存放尚未完成、可獨立執行與驗證的工作。系統現況、長期架構與工程規範以
[`docs/`](../docs/) 為唯一來源；已完成或跳過工作的理由與證據留在 git history 與合併紀錄，
不在此目錄維護歷史狀態表。

## Public-testing prerequisites

1. [Backend rate limits](./backend-rate-limits.md) — `Blocked`，等待 Redis 開通。限制 join、
   snapshot write、asset upload 與 asset resolve 的共享呼叫速率。
2. [Operator data retirement](./operator-data-retirement.md) — `Ready`。提供 scene、room、account
   三種 admin 清理能力，完整沿用現有 object、room 與 relational lifecycle。

兩份工作都必須在公開測試前完成。Rate limit 限制濫用的量；operator retirement 處理濫用或
測試後的資料清理。兩者可在 Redis 開通前後各自實作，但公開測試需要同時滿足。

## Completion rule

完成 active work 時：

1. 通過該文件列出的驗證與 repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、
   `pnpm knip`；
2. 把實作後的現況與長期 invariant 更新到對應的 `docs/` 文件；
3. 修正所有 source／docs inbound references；
4. 移除已完成的 plan，不在 `plans/` 留 completion evidence 或歷史狀態副本。

是否在兩份工作都完成後刪除 `plans/` 目錄，需另作決定；本索引不預先授權。
