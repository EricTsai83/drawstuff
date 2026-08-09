# 原生 UI 整合契約

- Status: Accepted
- Date: 2026-08-01
- 出處：Plan 05（2026-08-01）
- Reference engine: lockfile-resolved `@excalidraw/excalidraw@0.18.1`
- 前置決策：`docs/architecture/excalidraw-public-api-gap-audit.md`
- 前置決策：**不修改 upstream**（不 patch、不 fork）。public API 沒有的能力必須
  先與 owner 討論，不得自行開 seam。

## 契約摘要

Drawstuff 保留 Excalidraw 原生 editor UI（toolbar、properties panel、undo/redo、
dialogs），產品功能**只透過 upstream 的 public props 與 render slots** 掛進去。
不 patch、不 fork、不讀 private API、不用 DOM selector 觸碰 upstream internals。

這份契約由測試守護，不只是文件：

| 守護對象                                                             | 機制                                                                       | 位置                                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 我們用到的 prop／slot 被 upstream 移除                               | `as const satisfies readonly (keyof T)[]` → `tsc --noEmit` 失敗            | `packages/excalidraw-adapter/tests/upstream-capability-audit.test.ts`（`describe("host integration surface (native UI integration contract)")`） |
| upstream 新增 prop／slot／option（可能代表既有 workaround 可以移除） | `assertNoUnauditedKeys<Exclude<keyof T, audited>>()` → `tsc --noEmit` 失敗 | 同上                                                                                                                                             |
| upstream 新增／移除 module export                                    | `Object.keys(upstream)` runtime 斷言                                       | 同上（同一份 upstream public-API 稽核 suite）                                                                                                    |
| app 直接 import canvas engine 或 adapter 內部路徑                    | `no-restricted-imports`                                                    | `eslint.config.ts`                                                                                                                               |
| app 對 upstream DOM 做全域查詢                                       | `no-restricted-syntax`（禁止 `document.querySelector*` 等）                | `apps/web/eslint.config.ts`                                                                                                                      |

升級 `@excalidraw/excalidraw` 時 **typecheck 與 test 必須都跑**，兩者抓到的方向不同
（理由見 `docs/architecture/excalidraw-public-api-gap-audit.md`
§「Confirmed gaps 與 reproduction test 對照」）。

## 我們依賴的 upstream public surface

以下是 `apps/web` 目前實際掛上的每一項。**新增依賴時必須同步加進上述 audit 測試**，
否則升級不會被擋下。

**只有 `components/excalidraw/excalidraw-editor.tsx` 會掛載 engine。**
published viewer 不再掛載 engine，改為渲染 `exportToSvg` 的靜態輸出（見
§「Published viewer（靜態 SVG）」）。

### Editor props（`ExcalidrawCanvas`）

adapter 的 `ExcalidrawCanvasProps`（`packages/excalidraw-adapter/src/types.ts`）
是這份清單的唯一入口，audit 測試會斷言兩者完全相同。

| Prop                 | 使用者 | 用途                                                                                                         |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `children`           | editor | 掛載 `MainMenu`／`Footer`／`WelcomeScreen` 與 dialogs                                                        |
| `excalidrawAPI`      | editor | 取得 `ExcalidrawImperativeAPI`                                                                               |
| `initialData`        | editor | 初始場景（Promise）                                                                                          |
| `isCollaborating`    | editor | 共編 session 啟用時通知 engine（Plan 11 POC）                                                                |
| `langCode`           | editor | 語言切換                                                                                                     |
| `libraryReturnUrl`   | editor | 讓官方 catalog 的 install link 回到 canonical editor root；不得包含 scene／room query 或 fragment capability |
| `onChange`           | editor | 場景持久化與 dirty tracking；共編啟用時同時餵 changed-element tracker                                        |
| `onLibraryChange`    | editor | 顯示個人 Library 的匿名／載入／儲存／錯誤狀態；不以此 callback 重寫 upstream merge 語意                      |
| `onPointerUpdate`    | editor | 共編 presence（pointer／button）廣播來源（Plan 11 POC）                                                      |
| `renderCustomStats`  | editor | Stats 面板加上 storage 用量                                                                                  |
| `renderTopRightUI`   | editor | compact product-action menu 或 regular／wide 共編、雲端儲存與分享 controls                                   |
| `theme`              | editor | 跟隨 app 主題                                                                                                |
| `UIOptions`          | editor | 見下表                                                                                                       |
| `validateEmbeddable` | editor | 補充 embed 網域白名單                                                                                        |
| `viewModeEnabled`    | editor | 共編 viewer role 的唯讀 UI；server authorization 仍是唯一權限來源                                            |

`zenModeEnabled` **已不在清單內**：它只有舊 published viewer 用得到，viewer 改成靜態 SVG
後已移除。`viewModeEnabled` 不再服務 published viewer，但共編 viewer role 需要它呈現唯讀 editor，
因此仍由 adapter expose；後端 room role authorization 不依賴這項 UI prop。

### `UIOptions.canvasActions`

upstream 的完整開關是 `toggleTheme`、`export`（`saveFileToDisk`、
`renderCustomUI`）、`clearCanvas`、`loadScene`、`saveAsImage`、
`saveToActiveFile`、`changeViewBackgroundColor`；**Drawstuff 只設定其中兩個**：
editor 保留 `toggleTheme`，並以 `export` 關掉預設的「儲存到磁碟」換上自訂 export
UI。其餘一律沿用 upstream 預設。

### `ExcalidrawImperativeAPI`

`addFiles`、`getAppState`、`getFiles`、`getName`、`getSceneElements`、
`getSceneElementsIncludingDeleted`、`scrollToContent`、`updateScene`（全部由
editor 一側使用）。

改寫 elements 時遵守 `docs/architecture/excalidraw-public-api-gap-audit.md`
§「Capability matrix」#4（含 §「逐項說明」的 `#4 selected element actions`）的
規則：一律用 `getSceneElementsIncludingDeleted()` 取來源、用 `newElementWith`
產生新物件，不得就地 mutate。

### 其他 public utilities

| Utility                                         | 使用者                   | 用途                                            |
| ----------------------------------------------- | ------------------------ | ----------------------------------------------- |
| `exportToSvg`（adapter：`exportSceneToSvg`）    | published viewer         | 把場景渲染成靜態 `SVGSVGElement`，不啟動 editor |
| `exportToBlob`（adapter：`exportCanvasToBlob`） | `lib/excalidraw.ts`      | PNG 匯出與縮圖                                  |
| `restore`（adapter：`restoreScene`）            | `lib/persisted-scene.ts` | 持久化資料的唯一 restore 邊界                   |

runtime tripwire：`it("pins the upstream export utilities the host renders scenes through")`。

### Library integration

原生 Library panel、import／export、item restore 與 merge 都由 Excalidraw 擁有。Drawstuff
不替換 panel，也不以 DOM、CSS 或 private API 改寫它；分類、搜尋、collection 與 catalog
metadata 不在 host integration surface。

adapter 的 `./library` public entry point 是唯一 Library 邊界，提供 upstream Library types、
`useExcalidrawLibrary`、`restoreExcalidrawLibraryItems`，以及安全的官方 Library fetch。Web app
只負責 user-scoped persistence adapter、canonical return URL、官方 origin allowlist 與同步狀態。
完整 `LibraryItems` snapshot 仍由 upstream restore，app 不建立第二套 item／element schema。

官方安裝只接受 `https://libraries.excalidraw.com` 的 `.excalidrawlib` URL。client 在交給
upstream restore／merge 前限制 response bytes，且 redirect 後的最終 URL 仍須位於相同
allowlisted origin。`libraryReturnUrl` 固定為 editor origin root，因此 scene query、協作 room id
與 fragment key 不會被送到第三方 catalog，也不會被 `#addLibrary` 回程覆寫。

登入身分切換時，controller 會先在沒有 persistence listener 的階段清空 engine 記憶體，再掛載
新身分的 adapter；這個順序避免前一帳號的 Library 被保存到下一帳號。匿名模式仍可使用原生
panel 與當次 session 的官方安裝，但沒有 backend durability。

### Render slots

| Slot            | 使用的成員                                                                                                                                                              | 掛載處                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `MainMenu`      | `Item`、`ItemCustom`、`Separator`、`DefaultItems`（`LoadScene`／`Export`／`SaveAsImage`／`SearchMenu`／`Help`／`ClearCanvas`／`ToggleTheme`／`ChangeCanvasBackground`） | `components/excalidraw/app-main-menu.tsx` + `components/excalidraw/main-menu/*`（只有 editor） |
| `Footer`        | 只有 children                                                                                                                                                           | `components/excalidraw/editor-footer.tsx`                                                      |
| `WelcomeScreen` | `Center`（`Logo`／`Heading`／`Menu`／`MenuItemLoadScene`／`MenuItemHelp`／`MenuItemLink`）、`Hints`（`MenuHint`／`ToolbarHint`／`HelpHint`）                            | `components/excalidraw/app-welcome-screen.tsx`                                                 |
| `Stats`         | `StatsRows`、`StatsRow`                                                                                                                                                 | `components/excalidraw/custom-stats.tsx`                                                       |

`Footer` 在 mobile 不會掛載（`docs/architecture/excalidraw-public-api-gap-audit.md`
§「Capability matrix」#7a），mobile 可用的 slot 只有 `MainMenu` 與
`renderTopRightUI`。

### Responsive action contract

Canvas slot composition 只信任 upstream 傳給 `renderTopRightUI` 的 `isMobile`；app 不複製
upstream 的 mobile 判斷。Host desktop controls 的密度只使用 `globals.css` 中唯一的
`canvas-wide`（1072px）breakpoint：regular slot 顯示 icon controls，wide slot 才加入文字。

`excalidraw-editor.tsx` 建立一份 typed `CanvasProductActions`，共編、雲端儲存與分享的所有
presentation 都使用同一個 handler 與狀態來源：

- mobile top-right 不重複呈現 product actions；這些操作統一收進 Main Menu；
- regular top-right 直接呈現三個 icon controls，不以 `invisible` 保留 breakpoint 空窗；
- wide top-right 顯示較高資訊密度，但不使用固定翻譯字寬；
- Scene 名稱／Rename、Share、Collaborate、Save、Dashboard 與 storage status 遵守互斥
  presentation：desktop 只使用外層 controls／Footer，mobile 只使用 Main Menu。因此 mobile
  不依賴不會掛載的 Footer，也不會與 desktop 入口同時出現。

一般 app surface 使用 Tailwind `sm`（640px）與 `lg`（1024px）。safe-area、surface gutter 與
dialog viewport height 由 `globals.css` 的 host tokens 統一提供；不得在個別 surface 重複寫一套
裝置判斷。

## Published viewer（靜態 SVG）

`/p/[slug]` **不掛載 editor**。`components/excalidraw/published-scene-viewer.tsx`
解壓場景與檔案後呼叫 adapter 的 `exportSceneToSvg`（upstream `exportToSvg`），
把回傳的 `SVGSVGElement` 掛進自己的容器，再由
`hooks/excalidraw/use-svg-pan-zoom.ts` 以 CSS `transform` 提供 pan／zoom／fit／
reset。主題切換時重新 export（`exportWithDarkMode`），其餘互動完全不進 engine。

因此 viewer：

- 不傳任何 editor prop（也就沒有 `viewModeEnabled`／`zenModeEnabled`），
  不取用 `ExcalidrawImperativeAPI`，不掛載任何 render slot。
- 不需要 `validateEmbeddable`：靜態輸出沒有開 `renderEmbeddables`，embeddable
  不會被載入成 iframe，所以沒有網域白名單問題。
- 不再需要任何 CSS override 去隱藏 upstream 的 UI（見 §Accepted limitations 第 2 點）。
- header 使用全站 safe-area token，mobile controls 與 menu action 至少 44px；compact menu
  保留作者資訊，長 scene／author name 由可量測的 header 可用寬度截斷。stage 擁有
  `touch-none` pan／zoom 與 overflow，不允許手勢變成 document scroll。

pan/zoom 的數學是純函式，單元測試在 `apps/web/tests/svg-pan-zoom.test.ts`
（zoom-at-point 不變量、clamp、fit 計算）。

已知的行為差異（刻意接受）：published 頁沒有 in-scene search、Help dialog 與
social links menu，iframe embed 變成靜態畫面，原生手勢改由上述 hook 實作。

## 新增一個 menu 功能的掛載規則

`MainMenu` 是新產品功能的標準掛載點。`app-main-menu.tsx` 只保留骨架：menu 組成、
以及必須渲染在 menu 外（避免關閉 menu 時被卸載）的 dialogs。

1. 在 `apps/web/src/components/excalidraw/main-menu/` 新增一個 item component，
   檔名為 `<action>-item.tsx`，只負責「一個產品動作」。
2. 只做「開一個 dialog／導頁／呼叫一個 handler」的動作，用共用的
   `MenuActionItem`（`main-menu/menu-action-item.tsx`）；它固定使用 upstream 的
   `dropdown-menu-item dropdown-menu-item-base` class 並渲染原生 button，鍵盤啟用交給
   button semantics。需要 upstream 行為（例如自動關 menu）時才直接用
   `MainMenu.Item`／`MainMenu.ItemCustom`。
3. Item 自己讀 i18n（`useAppI18n`）與自己的 icon；label 不要由骨架傳進來。
4. 在 `app-main-menu.tsx` 加一行掛載；需要登入才顯示就寫成
   `{session && <XxxItem … />}`。
5. 需要 dialog 就把 dialog 渲染在 `<MainMenu>` **之外**，state 放在骨架。
6. 需要跨多次互動的商業邏輯（mutation、上傳、workspace 處理）放到
   `apps/web/src/hooks/excalidraw/` 的 hook，不要寫在 item 或骨架裡。

### 測試要求

- 每個 item 都要有獨立單元測試：`apps/web/tests/main-menu-items.test.tsx`。
- 在 Excalidraw 樹外單獨渲染時，會 throw 的是 **i18n hook chain**
  （`useAppI18n` → adapter `useI18n` → upstream `jotai-scope` `createIsolation()`
  的 isolated `useAtomValue`），不是 `MainMenu.Item`／`ItemCustom` 本身
  （它們只是套用預設 context 的 button／div）。單元測試請 mock
  `@drawstuff/excalidraw-adapter/client` 的 `useExcalidrawI18n`，其餘照常渲染。
- **已知缺口：** `workspace-switcher-item`、`dashboard-link-item`、`account-item`、
  `theme-item`、`language-item` 目前只有間接覆蓋。
  `apps/web/tests/e2e/excalidraw-smoke.spec.ts` **不會登入**，所以需要 session
  的 item 在 E2E 也沒被走到；補這幾個 item 時請直接補單元測試。

## 禁止事項

1. **不得 patch 或 fork upstream。** 需要 public API 沒有的能力時，先與 owner
   討論（見本文件開頭的前置決策）。
2. **不得使用 private／undocumented API。** 包含 `app.actionManager`、
   `app.history`、未 export 的 helper、`@excalidraw/excalidraw/*` deep import
   （已由 `no-restricted-imports` 擋下）。
3. **不得用 DOM selector 觸碰 upstream internals。** 不得依賴 upstream 的
   class name、`data-testid`、DOM 結構。`document.querySelector` 等全域查詢已由
   `no-restricted-syntax` 在 `apps/web/src/**` 全面禁止。
4. **不得用 CSS override 隱藏或改寫 upstream UI**
   （`docs/architecture/excalidraw-public-api-gap-audit.md` §「被否決的設計（不得進入
   production）」已否決 `.App-toolbar { display: none }` 這類做法）。
5. **不得用 timer polling 讀 `getAppState()`**，也不得對 editor container 派送
   合成 `KeyboardEvent` 來觸發 upstream action。
6. **不得在 `onChange` 內掃描全 scene**
   （`docs/architecture/excalidraw-public-api-gap-audit.md`
   §「Notification／render cost 評估」）。

## Accepted limitations

### 1. `MainMenu` trigger 沒有 accessible name（隔離的唯一 DOM workaround）

- **模組**：`apps/web/src/components/excalidraw/main-menu/accepted-limitation-trigger-label.ts`
  （檔名即標註；模組頂端有完整說明與 source 行號）。
- **證據**：`MainMenu` 自己渲染
  `<DropdownMenu.Trigger data-testid="main-menu-trigger">`，children 只有
  hamburger icon，沒有 `aria-label`／`title`
  （`dist/dev/index.js:17552-17565`、`:10729-10761`）。`MainMenu.Trigger` 雖然有
  export，但 `DropdownMenu` 只從**自己的 children** 找 trigger
  （`getMenuTriggerComponent`, `:10889-10901`），host 渲染的 `MainMenu.Trigger`
  會落在 dropdown content 裡，不會取代真正的 trigger。`MainMenu` 的 props 只有
  `children`／`onSelect`／`__fallback`，沒有任何 trigger 覆寫點。
  截至撰寫時沒有對應的 upstream issue。
- **做法**：以 `document.querySelector('[data-testid="main-menu-trigger"]')` +
  `MutationObserver` 補上 `aria-label="Menu"`，`langCode` 改變時重跑。
- **防擴散**：`apps/web/eslint.config.ts` 的 `no-restricted-syntax` 禁止
  `apps/web/src/**` 出現全域 DOM 查詢，只有這一個檔案被列為例外。
- **移除條件**：upstream 自己給 trigger accessible name，或開放 host 傳入
  trigger。audit 測試的 `MainMenu` prop／slot pin 一變動就會失敗，那就是重新
  評估的時機。移除時同時刪掉 ESLint 例外。
- **測試**：`apps/web/tests/main-menu-trigger-label.test.tsx`（單元）、
  `apps/web/tests/e2e/excalidraw-smoke.spec.ts`（accessible name 與 axe）。

### 2. Published viewer 的 zen-mode CSS override（**已解決，2026-08-01**）

`apps/web/src/styles/globals.css` 曾以
`.published-viewer .excalidraw .layer-ui__wrapper .disable-zen-mode`（等三條）
把「離開 zen mode」按鈕與 footer 隱藏，依賴 upstream 的 class name，違反上面第
3／4 條。

**解決方式不是換一個 selector，而是移除需求本身**：published 頁不再掛載 editor，
改為渲染 `exportToSvg` 的靜態輸出（見 §「Published viewer（靜態 SVG）」），因此
畫面上根本沒有 upstream UI 需要隱藏。那三條 CSS 規則已刪除（連同已無用途的
`.published-viewer` root class），viewer 也不再傳
`viewModeEnabled`／`zenModeEnabled`。**這是本文件唯一針對 upstream internals 的
CSS override，現在的 override 數量是零。**

### 3. 其他（沿用 public API gap audit 的結論）

- `toast.unableToEmbed` 文案無法覆寫單一 locale key（G3）——accepted，不處理。
- mobile 不會渲染 host `Footer` slot。
- `onChange` 是 render-frequency 訊號，需要 host 自行 dedupe。
