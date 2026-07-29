# Plan 07：審核公開 API 缺口

- Status: Ready
- Depends on: Plan 06
- Expected change size: 測試、spike 與一份決策表

## Outcome

以可重現證據決定是否需要維護 upstream patch；不能只因為實作不方便就 fork。

## In scope

- 對 pinned `@excalidraw/excalidraw@0.18.1` 建立 capability matrix。
- 驗證以下能力是否只靠 public API 即可完成：
  - primary tools
  - active/locked tool state
  - style defaults
  - selected element actions
  - undo/redo
  - upstream toolbar 隱藏或替換
  - mobile UI
  - collaboration callbacks 所需 state
- 每個缺口附最小 reproduction test。
- 做出 `public API sufficient` 或 `minimal patch required` 決策。

## Out of scope

- 在本 plan 實作 upstream patch。
- 評估完整 engine rewrite。
- 因美觀偏好修改 engine internals。

## Steps

1. 將目前 controller methods 對應到 upstream public symbols。
2. 對所有 fallback、DOM query 或 private property 標記為 gap。
3. 為每個 gap 建立最小失敗測試或 spike。
4. 判斷是否能用較小的 product UX 調整消除 gap。
5. 將結果寫入 `docs/`，包含版本、source link 與決策。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/web test:e2e
pnpm architecture:guard
```

## Done when

- 每個 toolbar capability 都有 public API、accepted limitation 或 confirmed gap。
- Plan 08 能明確標記為 `Ready` 或 `Skipped`。
- 沒有 production code 依賴 DOM selectors 或 undocumented internals。
