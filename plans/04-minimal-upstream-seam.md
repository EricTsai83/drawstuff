# Plan 04：補上最小 upstream API seam

- Status: Skipped — 不修改 upstream（2026-08-01 owner 決策）
- Depends on: Plan 03 的 `minimal patch required` 決策（已成立，後被下述決策取代）

## 決策紀錄（2026-08-01）

Owner 確立原則：**Excalidraw 沒提供 public 客製化 API 的能力，一律不修改
upstream（不 patch、不 fork）；要動一定先討論。** 同時產品方向改為保留原生
editor UI（toolbar、properties panel、undo/redo），只透過 public slots 掛產品
功能。因此本 plan 整體標記為 Skipped：

- **G2（undo/redo command）**：曾以 pnpm patch 完整實作並通過 review，於同日
  依本決策全數 revert。原生 toolbar 保留後，undo/redo 直接用 upstream 內建
  UI 與快捷鍵，不需要 host 呼叫入口。
- **G1（隱藏原生 toolbar）**：自訂 toolbar 路線取消，不再需要。
- **G4（container-bound text reflow）**：只有自訂 style controls 需要它；原生
  properties panel 內部自行處理 reflow，不受影響。
- **G3（`toast.unableToEmbed` locale 覆寫）**：accepted limitation，不處理。

Plan 03 的 capability matrix 與 `upstream-capability-audit.test.ts` tripwire
**維持有效**：它們守住「只依賴 public API」的邊界，並在升級 upstream 時強制
重新稽核（若 upstream 未來自行 export 這些能力，tripwire 會失敗提示重新評估）。
若日後有新能力確認非 patch 不可，須先與 owner 討論，經同意後以本 plan 原始
規格（如下保留）另開執行。

---

以下為原始 plan 內容，保留作為「若未來經討論同意 patch」的執行規格。
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
