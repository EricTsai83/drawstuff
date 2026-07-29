# Plan 08：接上樣式與 selection controls

- Status: Ready
- Depends on: Plan 07
- Expected change size: 一個 properties panel 與有限 style commands

## Outcome

自訂 UI 可以安全地修改新 element defaults 和已選 elements 的常用樣式，正確
處理 mixed selection，並完成 toolbar 單一路徑 cutover。

## In scope

- Stroke color、background color、fill style。
- Stroke width/style、sloppiness、opacity。
- Font family、font size、text alignment；只在適用 selection 顯示。
- Arrowhead；只在線性 element 適用時顯示。
- Mixed/unsupported/disabled state 的明確 UI。
- Undo/redo 必須包含 style updates。
- 達到已定義 parity 後移除 Plan 06 feature flag、舊 product toolbar wrappers、
  hidden duplicate UI、舊 styles、dead translations 和只測舊路徑的 tests。

## Out of scope

- 自訂 Excalidraw element schema。
- 直接 mutate selected elements。
- 不在目前產品需求內的所有 upstream properties。

## Steps

1. 定義 `SelectionSummary` 的 supported、mixed 和 value semantics。
2. 分開處理「沒有 selection 時更新 current style」與「有 selection 時執行
   element action」。
3. 每種 control 僅呼叫 controller command。
4. 驗證 group、bound text、multi-selection 和 locked elements。
5. 補 undo/redo、keyboard selection change 與 mobile panel 測試。
6. 執行 cutover cleanup inventory 與 Knip/import scan，確認 app 只有一套 toolbar
   composition；rollback 依靠部署回退，不在新版本保留舊 implementation。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 常用樣式可由 Drawstuff UI 修改。
- Mixed selection 不會顯示錯誤單一值或破壞不支援的 element。
- 所有修改都進入 upstream history，undo/redo 結果正確。
- Custom toolbar 不再由 feature flag 控制，production bundle 沒有舊 toolbar
  runtime path、雙重 controller subscription 或 dead code。
- Large mixed selection 的摘要與 style update 符合 Plan 00 budget；不會因每個
  control 各自掃描全 selection 而產生重複 O(n) 工作。
