# Plan 10：建立官方 reconciliation adapter

- Status: Completed
- Depends on: Plan 09
- Expected change size: 一個 merge adapter 與 differential fixtures

## Outcome

所有遠端 element updates 都由目前解析的 Excalidraw `reconcileElements` 合併；
Drawstuff 不存在第二套 merge algorithm。

## In scope

- Adapter 暴露狹窄的 `reconcileRemoteElements()`。
- 建立 `getSyncableElements()`，遵守既有 tombstone 與 invisible-element policy。
- 建立 changed-element extraction：依 upstream `version`/`versionNonce` 追蹤上次已送
  state，批次送出 delta；不得在 pointer-only change broadcast/serialize 全 scene。
- 對目前解析的 upstream 版本建立 differential fixtures。
- 測試 element ordering、`version`、`versionNonce`、deletion 和 simultaneous edits。
- Collaboration 只能依賴 adapter 的狹窄 contract，adapter 不反向依賴
  collaboration，維持 Plan 00 dependency DAG。

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
6. 量測 1k/10k elements 的 local change extraction、remote reconcile、allocation
   與 payload bytes；設定 batching/coalescing budget 和 tombstone compaction 邊界。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/collaboration test
pnpm lint
pnpm typecheck
```

## Done when

- Adapter 與 lockfile 解析的 upstream 版本 differential results 一致。
- Collaboration code 沒有自訂 version winner 或 ordering 邏輯。
- Deleted tombstones 可以跨 client 正確收斂。
- Pointer/presence update 不進入 element reconciliation；單一 element edit 的
  serialization/payload 與 changed element 數量相關。若 upstream callback 迫使
  change detection 或 reconciliation 掃過完整 scene，僅允許一次無 clone 的 pass，
  並須獨立量測、符合 large-scene budget，不得再疊加多次 O(n) transforms。
