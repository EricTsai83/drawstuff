# Plan 04：補上最小 upstream API seam

- Status: Ready
- Depends on: Plan 03 的 `minimal patch required` 決策（已成立）
- Expected change size: 每個 confirmed gap 一個獨立、長期維護的 integration seam
- Confirmed gaps（依 Plan 03 決策，分四次獨立執行）：
  1. **G2** — `ExcalidrawImperativeAPI` 沒有 host 可呼叫的 undo/redo command
     （`History.undo/redo`、`actionUndo`/`actionRedo` 已存在但未 export）。
  2. **G1** — `UIOptions` 沒有隱藏 upstream primary tool island 的 visibility
     option（`viewModeEnabled` 會停用編輯，`zenModeEnabled` 不會隱藏該 island，
     且會把 host `Footer` slot 一併推出畫面）。
  3. **G3** — 沒有覆寫單一 locale key 的 public API，`toast.unableToEmbed` 文案
     無法在地化（不阻擋其他 plan）。
  4. **G4** — 沒有 public 的 container-bound text reflow command
     （`redrawTextBoundingBox` 已存在但未 export；`restoreElements` 的
     `refreshTextDimensions` 只重算 text 自身尺寸，不會放大 container，也不會用
     `computeBoundTextPosition` 重新定位 bound text，而重建該行為所需的
     `measureText`／`wrapText`／`getFontString`／`getBoundTextMaxWidth`／
     `computeContainerDimensionForBoundText`／`computeBoundTextPosition`／
     `getContainerElement` 全部未 export）。與 G2 同屬「upstream 已存在但未 export
     的 stable command」，順序排在 G3 之後。

  證據與 reproduction：`docs/architecture/03-public-api-gap-audit.md`、
  `packages/excalidraw-adapter/tests/upstream-capability-audit.test.ts`。

## Outcome

只暴露產品真正需要、public API 缺少的 command/selector/slot；這是有 ownership、
upgrade test 與退出條件的正式 dependency integration，不是暫時 workaround。
Canvas engine 行為與 document semantics 不變。

## In scope

- 只處理 Plan 03 有 reproduction 的 confirmed gaps。
- 優先順序：
  1. upstream 已存在但未 export 的 stable command/selector；
  2. 小型 render slot；
  3. 最小 visibility option。
- 使用可審查、可重套用的 pnpm patch 或精確 commit fork。
- 在 adapter 內吸收 patched API，不讓 app 知道 fork 細節。
- 記錄 upstream source commit、patch diff 和移除條件。
- 禁止 monkey patch、runtime prototype mutation、DOM selector、copy/paste upstream
  implementation、`patch-package` postinstall side effect 或未 pin commit 的 fork。

## Out of scope

- Copy 整個 `excalidraw-app`。
- 修改 element type、serialization、reconciliation、history 或 rendering engine。
- 在同一個 patch 順便調整 upstream UI 視覺。

## Steps

1. 若 Plan 03 無 confirmed gap，將本 plan 標記為 skipped。
2. 若有多個不相關 gaps，為每個 gap 複製本 plan，分開執行。
3. 對第一個 blocking gap 建立最小 patch 和 regression test。
4. 重新執行 upstream contract fixtures。
5. 以 package override 與 contract test 驗證指定 patched dependency。
6. 記錄未來升級時如何檢查 patch 是否已被 upstream 取代。
7. 對 patch application failure 採 fail-fast；不得靜默退回 private API 或舊 UI。

## Verification

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- 每行 upstream diff 都能對應一個 confirmed gap。
- Native scene、export 與 persistence contract tests 完全相同。
- App 仍只透過 adapter 使用新增 seam。
- Lockfile、CI 和 upgrade runbook 能證明實際執行的一定是已審核版本；沒有第二套
  fallback implementation。
