# Plan 05：接上核心繪圖工具

- Status: Ready
- Depends on: Plan 04
- Expected change size: 一組 tool buttons 與 controller commands

## Outcome

使用者可以從 Drawstuff toolbar 選擇最常用工具，active state 與 canvas 真實狀態
一致。

## In scope

- 接上 selection、hand、rectangle、diamond、ellipse、arrow、line、freedraw、
  text、eraser。
- 顯示真實 active tool。
- 保留 upstream keyboard shortcuts。
- 處理 locked tool、one-shot tool 與 selection 返回狀態。
- 在 feature flag 下隱藏重複的 upstream primary tool UI。

## Out of scope

- Stroke/fill/font 等 style controls。
- Library、image import、laser pointer 等次要功能。
- 修改 upstream tool state machine。

## Steps

1. 建立 Drawstuff tool ID 到 upstream tool ID 的唯一 mapping。
2. Tool buttons 只呼叫 controller command。
3. 從 controller subscription 更新 active/locked UI。
4. 測試 button、shortcut 和 canvas gesture 三種切換來源。
5. 驗證 mobile toolbar overflow 與 tooltip shortcut 顯示。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm architecture:guard
```

## Done when

- 每個列出的工具都可被選取並實際在 canvas 建立正確 element。
- Keyboard shortcut 與 toolbar active state 不會不同步。
- 關閉 feature flag 仍可回到 upstream toolbar。
