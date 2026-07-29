# Plan 08：補上最小 upstream API seam

- Status: Ready（條件式）
- Depends on: Plan 07 的 `minimal patch required` 決策
- Expected change size: 每個 confirmed gap 一個小型 patch

## Outcome

只暴露產品真正需要、public API 缺少的 command/selector/slot；canvas engine 行為與
document semantics 不變。

## In scope

- 只處理 Plan 07 有 reproduction 的 confirmed gaps。
- 優先順序：
  1. upstream 已存在但未 export 的 stable command/selector；
  2. 小型 render slot；
  3. 最小 visibility option。
- 使用可審查、可重套用的 pnpm patch 或精確 commit fork。
- 在 adapter 內吸收 patched API，不讓 app 知道 fork 細節。
- 記錄 upstream source commit、patch diff 和移除條件。

## Out of scope

- Copy 整個 `excalidraw-app`。
- 修改 element type、serialization、reconciliation、history 或 rendering engine。
- 在同一個 patch 順便調整 upstream UI 視覺。

## Steps

1. 若 Plan 07 無 confirmed gap，將本 plan 標記為 skipped。
2. 若有多個不相關 gaps，為每個 gap 複製本 plan，分開執行。
3. 對第一個 blocking gap 建立最小 patch 和 regression test。
4. 重新執行 upstream contract fixtures。
5. 在 architecture guard 中鎖定只允許指定 patched dependency。
6. 記錄未來升級時如何檢查 patch 是否已被 upstream 取代。

## Verification

```sh
pnpm install --frozen-lockfile
pnpm architecture:guard
pnpm typecheck
pnpm test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- 每行 upstream diff 都能對應一個 confirmed gap。
- Native scene、export 與 persistence contract tests 完全相同。
- App 仍只透過 adapter 使用新增 seam。
