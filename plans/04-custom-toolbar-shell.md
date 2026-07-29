# Plan 04：建立 Drawstuff toolbar 外殼

- Status: Ready
- Depends on: Plan 03
- Expected change size: 一個 UI component，尚未取代所有原生 controls

## Outcome

畫布上可顯示使用 Base UI、Tailwind 和 Drawstuff tokens 的自訂 toolbar shell，
並可透過 feature flag 與既有 UI 並存。

## In scope

- 在 `apps/web` 建立產品專屬 toolbar component。
- 完成 desktop/mobile layout、focus order、tooltip 與 accessible labels。
- Toolbar 從 `WhiteboardController` 讀取狀態。
- 初期 buttons 可以 disabled，但不得使用假 state。
- 加入 feature flag，預設仍可安全退回原生 toolbar。

## Out of scope

- 完整工具行為。
- 樣式面板。
- 隱藏所有 upstream UI。

## Steps

1. 定義 toolbar 的 responsive layout 與 tool groups。
2. 使用既有 design tokens 和 Base UI primitives 實作 shell。
3. 接 controller provider/context，不直接 import upstream package。
4. 加入 keyboard focus、tooltip 和 mobile overflow 測試。
5. 加入視覺或 E2E smoke coverage。

## Verification

```sh
pnpm --filter @drawstuff/web lint
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- Feature flag 開啟時可看到自訂 toolbar shell。
- Feature flag 關閉時完全回到原本行為。
- Toolbar UI 沒有 direct upstream imports。
