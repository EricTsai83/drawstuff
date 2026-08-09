# Web RWD 重新設計

- Status: Ready
- Design inputs:
  [native UI integration contract](../docs/architecture/native-ui-integration-contract.md)、
  [workspace overlay routing](../docs/architecture/workspace-overlay-routing-system-design.md)、
  [shadcn Button](https://ui.shadcn.com/docs/components/base/button)、
  [shadcn Dialog](https://ui.shadcn.com/docs/components/base/dialog)、
  [shadcn Dropdown Menu](https://ui.shadcn.com/docs/components/base/dropdown-menu)
- Expected change size: 中大型前端重構；不改 backend、DB schema、collaboration wire protocol，
  不 patch 或 fork Excalidraw upstream

目前多數一般頁面已有基本的單欄、換行與 grid breakpoint，但 Canvas chrome、route overlay、
Dashboard filter、dialogs 與 published viewer 沒有共同的 responsive contract。最明顯的結果是
Canvas 的主要操作在 mobile 完全不 render，且 `728–1071px` 之間雖然 render，卻被
`invisible`；同一空窗也影響場景名稱。這不是單一按鈕 bug，而是缺少跨 surface 的資訊架構與
驗收矩陣。

## Outcome

Drawstuff 在 320px 手機、橫向手機、平板、窄桌面與寬桌面都能完成相同的核心工作；版面可以
依空間改變密度與呈現方式，但 Save、Share、Collaborate、場景命名、Dashboard navigation 與
route close 不會因 breakpoint 消失。所有 host-owned controls 都有一致的觸控、鍵盤、focus、
loading/error/status 與中英文長字串行為。

## Current gaps

1. **Canvas mobile 直接移除產品操作。**
   `excalidraw-editor.tsx` 的 `renderTopRightUI` 在 `isMobile` 時回傳 `null`，連帶移除
   Collaborate、Cloud Upload 與 Share。Upstream mobile 又不掛載 host `Footer`，所以 footer
   內的 Dashboard shortcut 與 storage status 也不能當替代入口。
2. **平板／窄桌面有刻意隱藏的空窗。** Collaboration、Cloud Upload、Share 與
   `SceneNameTrigger` 都在 `728px` 開始 `invisible`，直到 `1072px` 才恢復；一般直向平板與
   1024px 橫向平板因此沒有直接操作。
3. **替代入口不對稱。** Share 尚可經 Main Menu → Export 進入，但路徑過深；Collaborate
   沒有 Main Menu 入口，使用者也無法重新打開 room dialog 管理連結、狀態或離開房間。
4. **Route overlay 在所有寬度固定為 80%。** Mobile 仍露出一條無功能的 Canvas backdrop，
   並以 `top-6` 加手算高度；沒有 safe-area、mobile full-screen 與 sticky route header contract。
5. **Dashboard 只是允許換行，不是 mobile IA。** Search、workspace、publish/archive/category
   filters 逐列堆疊，耗用大量首屏；scene grid 到 `md` 才成兩欄，320–767px 沒有分級調整。
6. **Dialogs 只有 max-width，缺少高度契約。** 長表單與 collaboration workflow 沒有統一的
   `100dvh` 上限、內部 scroll、mobile keyboard 與 sticky actions 規則；各 dialog 自己排列
   footer buttons。
7. **Published viewer 已有 desktop／mobile controls menu，但尚未納入全站 contract。**
   Header title、touch target、safe-area、橫向手機與 200% zoom 尚無跨 viewport 驗收。
8. **現有 E2E 會略過問題。** Mobile project 雖存在，Canvas smoke test 以寬度條件跳過名稱
   assertion；workspace overlay test 則固定要求所有 viewport 都維持 75–85% 寬，反而鎖住目前
   不理想的 mobile presentation。沒有測試保證核心操作在每個 tier 可達。

## Responsive contract

### 1. 兩種 breakpoint 系統，各自只有一個 owner

一般 app surfaces 與 Canvas 不共用一套假裝精準的 breakpoint：

| Surface                                         | Compact                  | Regular                            | Wide      | Owner                                                            |
| ----------------------------------------------- | ------------------------ | ---------------------------------- | --------- | ---------------------------------------------------------------- |
| 一般頁面、Dashboard、workspace、dialogs、viewer | `<640px`                 | `640–1023px`                       | `≥1024px` | Tailwind mobile-first `sm`／`lg`                                 |
| Canvas slot composition                         | upstream 回報 `isMobile` | upstream desktop slot 且 `<1072px` | `≥1072px` | `renderTopRightUI(isMobile)` + 單一 `canvas-wide` CSS breakpoint |

- 不在 app 內重算 Excalidraw 的 730px／landscape mobile 公式；slot 在哪裡由 upstream 的
  `isMobile` 參數決定。
- `1072px` 只控制 host desktop controls 要顯示 icon-only 或 icon + label。若 Tailwind v4
  需要命名 breakpoint，在 `globals.css` 定義一次 `canvas-wide`，不再散落
  `min-[1072px]`。
- Layout 判斷以 viewport/container 能力為準，不以 user agent 或裝置名稱分支。

### 2. 不可消失的功能 invariant

在每個 tier，以下能力必須有可見、可 focus 且可操作的入口：

- 場景名稱與 Rename；
- Dashboard navigation（登入時）；
- Save to cloud（登入時）與目前 save/offline/error 狀態；
- Create shareable link；
- Collaborate，以及 connected、read-only、sync-blocked、reconnecting、failed 等狀態；
- Main Menu 與目前 Canvas 的必要 restore/export 能力。

允許把文字按鈕收成 icon 或 menu item，但不允許只用 `invisible`、`display:none` 或
`pointer-events:none` 移除唯一入口。所有等價入口使用相同 handler 與狀態來源，不複製商業邏輯。

### 3. Mobile interaction contract

- Host-owned mobile touch target 最少 `44 × 44px`；upstream controls 保持 upstream 尺寸，
  不用 CSS override 改寫。
- Icon-only control 一律有 translated `aria-label`、tooltip/title 與清楚的 selected/status state；
  decorative icon 使用 `data-icon`／`aria-hidden`，不以顏色作唯一訊號。
- 使用 `100dvh`／`env(safe-area-inset-*)` 處理瀏海、Home indicator 與 mobile browser chrome；
  有文字輸入的 surface 必須在軟鍵盤打開後仍能看見 active field 與 primary action。
- 320px 寬不得產生 document-level horizontal scroll。需要橫向瀏覽的 chip/list 必須是明確的
  local scroll region，並保留鍵盤與 screen-reader 操作。
- 英文與繁體中文都納入驗收；status label、workspace name 與 scene name 以長字串測試 truncation，
  不以固定 `ch` 寬度假設翻譯長度。

## Target design by surface

### A. Canvas chrome and product actions

#### Mobile slot（upstream `isMobile === true`）

- `renderTopRightUI` 不再回傳 `null`；render 一個 44px compact product-action trigger。Trigger
  顯示 Collaboration 的 live status indicator，accessible name 說明「分享與共編」及目前 room
  狀態，避免已連線／唯讀／sync-blocked 在手機上完全不可見。
- Main Menu 新增一個 host product actions group，直接列出：
  1. Collaborate／目前 room 狀態；
  2. Save to cloud／目前 save 狀態（僅登入）；
  3. Share link。
- Compact trigger 打開的 menu 與 Main Menu items 共用同一組 action model/handlers；前者提供
  快速入口，後者是所有 mobile 與輔助技術都可找到的穩定入口。
- `SceneTitle` 在 Main Menu 所有 tier 都保留，而非以 728px 隱藏；mobile 的 Rename 由此進入。
- Dashboard link 已存在於 Main Menu；storage usage/status 也要增加 menu presentation，因為
  `Footer` 在 mobile 不掛載。Footer 本身只作 desktop convenience，不再是資訊唯一來源。

#### Regular Canvas（desktop slot，寬度 `<1072px`）

- Top-right 顯示三個不帶長文字的 controls：Collaborate status、Cloud Save、Share。可使用
  shadcn `Button size="icon"`／`icon-lg`，但保留完整 accessible name 與 tooltip。
- 不使用 `invisible` 保留空白；controls 實際佔用多少空間就 render 多少空間。
- `SceneNameTrigger` 自 730px desktop slot 起顯示為可截斷的 compact title；寬度由可用空間限制，
  不與 toolbar/top-right controls 重疊。

#### Wide Canvas（`≥1072px`）

- 延續目前 Collaborate label、Cloud icon、Share label 的資訊密度；改用既有 Button size/variant，
  不以固定 `w-[12ch]` 配合翻譯。
- Loading 時允許 label 改變，但 control 以合理 min-width 或 overlay spinner 避免整列劇烈位移。
- Collaboration label、read-only 與 sync-blocked 同時維持 visual + accessible status。

#### Component boundary

- `ExcalidrawEditor` 只建立 action handlers/state，並把一個 typed action model 傳給
  `TopRightControls` 與 `AppMainMenu`。
- Presentation components 只決定 icon/label/menu layout，不直接呼叫 export、upload 或 room
  lifecycle。
- 新增 Main Menu action 時遵守 native UI integration contract：每個 action 是獨立 item，dialog
  留在 menu 外，不能觸碰 upstream DOM/private API。

### B. Dashboard and scene cards

#### Compact

- 外框 padding 降為 16px，heading 上方留白縮短；workspace selector 與 manage action 使用完整
  一列，selector 可伸展，不以 `w-48` 限制。
- Search 永遠在首屏可見。Publish、Archive、Category 收入一個「Filters」Dialog/Popover：
  compact 使用 Dialog，regular/wide 可使用 Popover 或 inline controls。Filter trigger 顯示 active
  count，清除 filters 是明確 action。
- Filter option 使用已安裝的 Select／RadioGroup，或在實作前明確從 `@shadcn` registry 加入
  Toggle Group；不得繼續以多組手寫 active Button 重複狀態語意。
- Scene grid：320px 為一欄；空間足夠的手機／小平板經實測後可在 `sm` 變兩欄。Card 的 menu、
  title、description、tags 與 metadata 不靠固定高度切掉唯一資訊；card action touch target ≥44px。

#### Regular and wide

- Workspace、search 與 filter toolbar 在 regular 重新排列為兩列，在 wide 才合併為高密度工具列。
- Grid 以 card 最小可用寬度為依據逐步增加欄數；scene skeleton 必須使用相同 grid contract，
  避免 loading → loaded layout shift。
- Empty/loading/end states 與 active result count 保持在 grid content flow 中，不以 viewport 高度定位。

### C. Route overlay and canonical workspace pages

Route destination 與 routing semantics 不變，presentation 改為：

| Tier    | Intercepted route presentation                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Compact | `inset-0`、`w-full`、`min-h/height: 100dvh` 的 full-screen route surface，不露出無功能的 Canvas 邊條 |
| Regular | 有一致外距的近全寬 dialog，限制 max-width，保留 backdrop                                             |
| Wide    | 約 80vw、合理 max-width 與上下外距，維持目前 Canvas-preserving overlay 感                            |

- Route header 有明確 title、close/back control 並 sticky；content 自己 scroll，route action 不會被
  mobile browser chrome 蓋住。
- 使用 Dialog 原生 focus trap、inert background、Escape 與 close lifecycle；不另建第二套
  `OverlayModal` 行為。Login overlay 評估遷移到同一 primitive，避免 backdrop click、focus 與
  scroll lock 規則分裂。
- Canonical `WorkspaceManagementShell` 與 intercepted `RouteOverlay` 共用 content spacing tokens，
  但 canonical page 保留 document navigation/back link，不模仿 modal。
- Soft navigation 必須繼續保留同一 Canvas instance；RWD 改造不能移動平行 route ownership。

### D. Dialogs and forms

建立共用的 dialog layout contract，而不是每個檔案各自拼 max-width：

1. **Compact confirm**：短文與 1–2 actions，mobile actions full-width 並以安全順序堆疊，`sm` 起
   才橫排。
2. **Form dialog**：mobile 使用接近 full-screen 的 content area、sticky header/footer、中央
   scroll body；desktop 保持 `max-w-md/lg`。
3. **Wide workflow**：Export 與 Collaboration 可容納多段狀態／link／permissions；mobile
   仍是單欄，長內容只讓 body scroll，不讓 title 或 final action 滾出後無法找回。

首輪涵蓋 Scene Rename、New Scene、Cloud Upload、Share Link、Collaboration Room、scene change、
sign-out、remote conflict、workspace delete/create/settings 與 category management。

- 每個 Dialog 保留 `DialogTitle`；description 可視覺隱藏但不可省略。
- Forms 使用 `FieldGroup` + `Field`；loading 使用 `Spinner`；actions 不因 keyboard 打開而不可達。
- Copy-link row 在 320px 可改成上下排列，input/link 不撐破 dialog。
- 不修改 shadcn primitive 的視覺 token；responsive class 只負責 layout。

### E. Published scene viewer

- 保留目前 desktop inline controls／mobile menu 的架構，不重寫 pan/zoom。
- Mobile header 加 safe-area，logo、scene title 與 controls 各自有可證明不碰撞的 max-width；作者
  名稱在 compact 可移到 menu/details，而不是默默消失成無替代資訊。
- Mobile menu 的按鈕提升為 44px touch target，操作後維持合理 open/close 行為；Escape、outside
  click、keyboard focus 與 `inert` 都要測試。
- 驗證 320px、390px、844×390 landscape、200% zoom 與長 scene/author name；stage 必須保留
  touch pan/zoom 且不產生 document scroll。

### F. Error, auth and utility surfaces

- Login、Auth Required、404/global error 在 320px 使用 16px side gutter，actions full-width；
  `sm` 起才回復自動寬度。
- Workspace dropdown、category menus 與 scene menus 的 popup 高度以 available viewport 為準，
  mobile keyboard 出現時仍可 scroll 到選項。
- 清除既有 host components 內的 `space-x-*`／`space-y-*`、手寫 truncation 與 icon sizing 違規，
  但不把 RWD 工作擴張成無關的全站視覺 redesign。

## Implementation steps

### 1. 先建立 responsive contract 與 characterization tests

- 在 `globals.css` 定義唯一的 host custom breakpoint/safe-area layout tokens；一般內容繼續使用
  Tailwind 預設 mobile-first breakpoints。
- 新增 responsive E2E helper，統一檢查 viewport、horizontal overflow、visible/focusable action 與
  touch/keyboard activation。
- 先寫會重現以下缺口的 failing tests：390px mobile 核心 actions、844×390 landscape、
  768/1024px tablet、route overlay mobile full-screen、320px dialog/form overflow。
- 移除 smoke test 中只按 `>=728` 才檢查核心能力的條件式；依 tier 改驗證直接入口或等價 menu
  入口。

### 2. 修正 Canvas action architecture（最高優先）

- 重構 `excalidraw-editor.tsx`、`top-right-controls.tsx`，讓 mobile 也 render compact action UI。
- 讓 `collaboration-button.tsx`、`cloud-upload-button.tsx`、`share-scene-button.tsx` 支援 compact／wide
  presentation，移除 728–1071px visibility hacks 與固定文字寬度。
- 在 `app-main-menu.tsx` 與 `main-menu/` 新增 Share、Save、Collaborate、Storage status items，與
  top-right controls 共用 action model。
- 修正 `scene-name-trigger.tsx`／`main-menu/scene-title.tsx` 的 rename fallback；任何 Canvas tier
  至少有一個入口。
- 補單元測試：所有 collaboration/save/share state 的 compact/wide label、disabled、aria-busy、
  status 與同 handler 行為。

### 3. 重做 Dashboard responsive information architecture

- 重排 `scene-search-list.tsx` 的 header、workspace、search 與 filters；新增 compact filter surface。
- 統一 `SceneGrid` 與 `SceneGridSkeleton` breakpoint；檢查 `scene-card.tsx`／`scene-card-menu.tsx` 的
  touch target、long content 與 menu viewport collision。
- 保留所有 URL/query filter semantics，不把 repeatable Dashboard state 改回 local-only state。

### 4. 重做 route overlay 與 workspace shell

- 將 `route-overlay.tsx` 改成 compact full-screen、regular near-full、wide constrained 的單一
  responsive shell，加入 sticky header、safe-area 與 content scroll ownership。
- 對齊 `workspace-management-shell.tsx` 的 content width、gutter 與 action layout。
- 評估並移除 `overlay-modal.tsx`；Login 改用同一 Dialog primitive。若仍有不同 lifecycle 的必要，
  需在 architecture doc 明確記錄，而不是默默維持兩套 modal system。
- 更新 routing E2E：mobile 不再要求 80% width；desktop 仍驗證 overlay 尺寸與 Canvas instance
  preservation。

### 5. 統一 dialogs、forms 與 transient feedback

- 依 Compact confirm／Form／Wide workflow 三種 layout contract 逐一遷移 dialog。
- 確保 sticky actions、內部 scroll、soft keyboard、safe-area、copy link、loading/error toast 與
  destructive confirmation 在 320px 可用。
- 只組合現有 shadcn components；若確實需要新 registry component，先以 `@shadcn/<name>` 明確
  記錄來源並依 CLI dry-run/diff 流程加入。

### 6. Published viewer 與全站 polish

- 調整 viewer header/menu touch targets、safe-area、長 title/author 與 landscape layout；保留現有
  SVG pan/zoom 純函式和 static viewer boundary。
- 補齊 auth/error/empty/loading surfaces 的 320px gutter、action stacking 與 overflow。
- 以中英文、anonymous/authenticated、light/dark、reduced motion 與 200% zoom 做最後巡檢。

### 7. 文件與收尾

- 把最終 breakpoint、Canvas action availability、overlay presentation 與 dialog layout invariant
  更新至 `docs/architecture/native-ui-integration-contract.md`、
  `docs/architecture/workspace-overlay-routing-system-design.md` 與必要工程規範。
- 修正所有仍把 mobile Footer 或 728–1071px 隱藏視為 accepted limitation 的註解／測試描述。
- 通過 verification 後移除此 active plan，依 `plans/README.md` completion rule 不保留已完成副本。

## File map

預期主要變更範圍：

- Foundation：`apps/web/src/styles/globals.css`、responsive test helpers；
- Canvas：`excalidraw-editor.tsx`、`top-right-controls.tsx`、三個 action buttons、
  `app-main-menu.tsx`、`main-menu/*`、`scene-name-trigger.tsx`、`editor-footer.tsx`；
- Dashboard：`scene-search-list.tsx`、`scene-card.tsx`、`scene-card-menu.tsx`、兩個 grid skeleton；
- Route surfaces：`route-overlay.tsx`、`workspace-management-shell.tsx`、`overlay-modal.tsx`、login；
- Dialogs：`components/excalidraw/*dialog.tsx`、`scene-share-dialog.tsx`、workspace/category dialogs；
- Viewer：`published-scene-viewer.tsx`；
- Tests：`apps/web/tests/e2e/excalidraw-smoke.spec.ts`、
  `workspace-overlay-routing.spec.ts`、新增 responsive E2E 與 focused component tests；
- Docs：兩份 architecture contracts 與相關 test comments。

## Verification matrix

### Required viewports

| Viewport    | Purpose                                              |
| ----------- | ---------------------------------------------------- |
| `320×568`   | 最小支援寬度、dialog/action stacking、無水平溢出     |
| `390×844`   | 主要 touch/mobile contract（現有 iPhone 12 project） |
| `844×390`   | Excalidraw short-landscape mobile 判定與 safe-area   |
| `768×1024`  | 直向平板；覆蓋目前 dead zone                         |
| `1024×768`  | 橫向平板／窄桌面；覆蓋目前 dead zone                 |
| `1280×800`  | 一般 laptop                                          |
| `1728×1080` | 現有 wide desktop baseline                           |

每個 viewport 至少驗證：

- Canvas 沒有 document horizontal scroll，toolbar 與 host actions 不互相遮擋；
- Share、Save（登入）、Collaborate、Rename、Dashboard 均可到達；
- collaboration idle／joining／connected／read-only／sync-blocked／failed 有可理解狀態；
- route overlay、local dialog、menu 的 Escape、backdrop、Back/Forward、focus return 正確；
- long English／Traditional Chinese labels、scene/workspace names 不破版；
- touch target、keyboard activation、screen-reader name、`aria-busy`／disabled state 正確；
- mobile keyboard、safe-area、portrait/landscape、200% browser zoom 可用。

### Automated checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
pnpm --filter @drawstuff/web test:e2e
```

E2E 至少保留 Chromium desktop/mobile 與 WebKit desktop/mobile；responsive spec 額外切換 320、
844×390、768 與 1024 widths。Axe 檢查除了 Canvas root，也要覆蓋 mobile action menu、route overlay
與至少一個 form dialog。Layout assertion 使用 bounding box、可見性、focus 與 scroll width，不以
脆弱的 implementation class name 當成功條件。

## Non-goals

- 不重新設計品牌、色票、字體或 Canvas drawing tools。
- 不 patch upstream DOM/CSS，不新增 private Excalidraw integration。
- 不在本工作改 backend permissions、room protocol、scene persistence 或 routing URL semantics。
- 不承諾 host 可以控制的 44px touch target 套用到所有 upstream-owned controls。
- 不為每個裝置建立獨立 React tree；只有 upstream 明確提供的 mobile/desktop slot 差異可分支。

## Done when

- 320px 到 wide desktop 的每個 required viewport 都有可操作的 Share、Save、Collaborate、Rename
  與 Dashboard path，且 728–1071px visibility hacks 已移除。
- Mobile collaboration room 的狀態與管理入口不再依賴 desktop-only UI；Share 不必先知道 Export
  dialog 才能找到。
- Dashboard、route overlays、canonical workspace pages、dialogs 與 published viewer 通過
  verification matrix，無 document-level horizontal overflow。
- Responsive E2E 不再以條件式略過核心能力，mobile/desktop overlay expectation 各自正確。
- Architecture docs 成為完成後 contract，repo-level lint/typecheck/test/knip 與 E2E 全數通過。
