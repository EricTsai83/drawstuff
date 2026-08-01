# Plan 08：接上樣式與 selection controls

- Status: Skipped — 路線取消（2026-08-01 owner 決策）

## 決策紀錄

產品方向改為保留 Excalidraw 原生 editor UI：樣式編輯（stroke／background／
fill／opacity／font 等）與 selection controls 一律使用原生 properties panel，
不再自訂。原因：

- 自訂 style controls 需要 G4（container-bound text reflow）等 upstream 未
  export 的能力，與「不修改 upstream」原則衝突；原生 panel 內部自行處理
  reflow，沒有這個問題。
- Undo/redo、mixed selection、O(n) command 成本等原 plan 要處理的複雜度，全部
  由原生 UI 承擔，產品不需要重新實作。

原始 plan 內容已由 git 歷史保留（commit 85e1fefd 之前的版本）。若未來重啟
自訂 editor UI 路線，須先與 owner 討論並重新評估 Plan 03 稽核結論。

產品客製化改走 Plan 05（原生 UI 整合契約與 Menu 整備）與 Plan 06／07
（dashboard 產品功能）。共編線（Plan 09 起）改依賴 Plan 05。
