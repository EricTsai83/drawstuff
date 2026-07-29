# Plan 10：建立官方 reconciliation adapter

- Status: Ready
- Depends on: Plan 09
- Expected change size: 一個 merge adapter 與 differential fixtures

## Outcome

所有遠端 element updates 都由 pinned Excalidraw 的 `reconcileElements` 合併；
Drawstuff 不存在第二套 merge algorithm。

## In scope

- Adapter 暴露狹窄的 `reconcileRemoteElements()`。
- 建立 `getSyncableElements()`，遵守既有 tombstone 與 invisible-element policy。
- 對 pinned upstream 建立 differential fixtures。
- 測試 element ordering、`version`、`versionNonce`、deletion 和 simultaneous edits。
- 將 collaboration package 接到這個 adapter contract。

## Out of scope

- 自行實作 CRDT。
- 修改 tombstone retention policy。
- Network transport。

## Steps

1. 將 ADR 0001 的 collaboration boundary 轉成 typed adapter API。
2. 以相同 local/remote fixtures 同時執行 upstream function 和 adapter。
3. 比對完整 semantic result，而非只比 element IDs。
4. 加入不同 client ordering 與 duplicate delivery 測試。
5. 對 upstream upgrade 建立 fixture version metadata。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/collaboration test
pnpm architecture:guard
pnpm typecheck
```

## Done when

- Adapter 與 pinned upstream 的 differential results 一致。
- Collaboration code 沒有自訂 version winner 或 ordering 邏輯。
- Deleted tombstones 可以跨 client 正確收斂。
