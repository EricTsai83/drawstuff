# Plan 05：建立穩定 Whiteboard controller

- Status: Ready
- Depends on: Plan 03，以及需要時的 Plan 04
- Expected change size: 一個 controller contract 與 adapter 實作

## Outcome

產品 UI 可以透過 Drawstuff 自己的 controller 讀取 editor 狀態與送出 commands，
不需要知道 `ExcalidrawImperativeAPI` 的完整形狀。

## In scope

- 定義小型 `WhiteboardController` interface。
- 第一版只加入後續 toolbar 必要能力：
  - `getActiveTool()`
  - `getSelectionSummary()`
  - `setActiveTool(tool)`
  - `updateCurrentStyle(stylePatch)`
  - `deleteSelection()`
  - `undo()` / `redo()`
- `deleteSelection()` 必須自行重現 upstream 的 delete contract（`fixBindingsAfterDeletion`
  未 export，見 Plan 03 audit §#4）：
  1. 以 `newElementWith(el, { isDeleted: true })` tombstone，不得從 array 移除。
  2. Container 的 bound text（`containerId` 指向被刪除 element）一併 tombstone。
  3. 清掉 linear element 指向已刪除 element 的 `startBinding`／`endBinding`；指向
     存活 element 的 binding 不得更動。
  4. 把已刪除的 id 從存活 element 的 `boundElements` 陣列移除。
  5. 不在 blast radius 內的 element 保留 referential identity。
- 提供訂閱 state change 的 API，使用 `useSyncExternalStore` 或同等穩定模式。
- 將 upstream appState/element types 轉成 Drawstuff-owned read model。
- 加入 controller unit tests。
- Snapshot 以 semantic equality/memoization 保持 referential stability；pointer move
  或不相關 appState change 不得通知 toolbar subscribers。
- Controller 有明確 attach/detach/dispose lifecycle，不殘留 listener 或 stale API
  reference。

## Out of scope

- Toolbar component。
- Collaboration。
- 一次包裝所有 upstream API。

## Steps

1. 從 toolbar use cases 反推最小 command/read model。
2. 在 adapter 內保存 upstream API reference，但不複製 scene state。
3. 將 upstream state change 轉為小型 immutable snapshot。
4. 驗證 controller command 不會直接改寫 element object。
5. 為沒有 editor instance、沒有 selection、mixed selection 補測試。
6. 使用 Plan 00 large-scene fixture 量測通知次數、selector cost 與 React commits；
   hot path 不複製完整 element array，且每個 relevant change 最多一次通知。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter typecheck
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm typecheck
```

## Done when

- App UI 只需要 controller 就能取得 active tool 與 selection summary。
- Commands 有 typed error/no-op semantics。
- Controller 沒有把 upstream internal store 暴露給 app。
- Strict Mode remount 後沒有重複 subscription；相同 semantic snapshot 不會造成
  re-render，controller overhead 符合已核准 budget。
