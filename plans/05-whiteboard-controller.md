# Plan 05：原生 UI 整合契約與 Menu 整備

- Status: Ready
- Depends on: Plan 03（capability audit 與 tripwire 已存在）
- Expected change size: adapter 契約測試對齊 + `AppMainMenu` 結構重整，無新產品功能

> 2026-08-01 改版：本 plan 原為「Whiteboard controller」（服務自訂 toolbar）。
> 產品方向改為保留原生 editor UI 後，controller/command API 整份取消；本 plan
> 改為鎖定「原生 UI + public slot」這條實際路線的整合契約。

## Outcome

「產品功能只透過 upstream public API 掛進 editor」成為有測試守護的明文契約；
`MainMenu` 成為新產品功能的標準掛載點——之後新增一個 menu 功能（例如開啟
dashboard、分類、封存）只需要新增一個獨立的 menu item component 並掛上，
不需要動 menu 骨架。

## In scope

- **盤點實際依賴的 public surface。** 逐一列出 `excalidraw-editor.tsx` 與
  `published-scene-viewer.tsx` 使用的 props／slots／`UIOptions`（現況：
  `excalidrawAPI`、`initialData`、`onChange`、`UIOptions.canvasActions`、
  `langCode`、`theme`、`renderTopRightUI`、`renderCustomStats`、
  `validateEmbeddable`、`viewModeEnabled`、`MainMenu`、`Footer`、
  `WelcomeScreen`），確認每一項都在
  `upstream-capability-audit.test.ts` 的 audited keys 內；缺的補進 audited
  清單，讓「升級 upstream 弄壞我們用到的 API」一定被 typecheck/test 抓到。
- **`AppMainMenu` 結構重整。** 目前約 585 行、混雜 menu 骨架與各功能邏輯。
  拆成「骨架 + 每個產品動作一個獨立 item component」（dashboard 連結、rename、
  new scene、settings、auth、theme、language…），dialogs 維持渲染在 menu 外的
  既有模式。純結構重整，行為不變。
- **處置既有的 DOM workaround。** `app-main-menu.tsx` 以
  `document.querySelector('[data-testid="main-menu-trigger"]')` + MutationObserver
  修補 menu trigger 的 aria-label，違反共同完成規則 #7 與「不依賴 upstream
  internals」原則。本 plan 內確認 upstream 是否已有 public 替代；沒有就把它
  隔離成單一明確標註的 accepted-limitation 模組（附 upstream issue 連結與移除
  條件），並禁止此 pattern 擴散。
- 在 `docs/architecture/` 記錄本契約（依賴的 slot 清單、掛載規則、禁止事項）。

## Out of scope

- 任何 upstream patch／fork／私有 API（見 Plan 04 決策紀錄）。
- 自訂 toolbar、controller、command API。
- 新產品功能（Plan 06／07）。

## Steps

1. 產出 editor／viewer 的 public-surface 依賴清單，對照 audited keys 補齊缺口。
2. 重整 `AppMainMenu` 為骨架 + item components；每個 item 有獨立測試或由既有
   E2E 覆蓋。
3. 處置 aria-label DOM workaround（public 替代或隔離＋記錄）。
4. 撰寫整合契約文件，連同本 plan 的掛載規則。
5. 刪除被取代的舊結構與只服務舊路徑的測試。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

## Done when

- 我們依賴的每個 upstream prop／slot 都在 audit tripwire 的守護範圍內。
- 新增一個 menu 產品功能 = 新增一個 item component + 一行掛載。
- repo 內除了被隔離並記錄的單一例外，沒有任何 DOM selector 觸碰 upstream
  internals。
- 契約文件存在且與程式碼一致。
