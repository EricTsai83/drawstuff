# Plan 03：建立穩定 Whiteboard controller

- Status: Ready
- Depends on: Plan 02
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
- 提供訂閱 state change 的 API，使用 `useSyncExternalStore` 或同等穩定模式。
- 將 upstream appState/element types 轉成 Drawstuff-owned read model。
- 加入 controller unit tests。

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
