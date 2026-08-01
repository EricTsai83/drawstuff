# Plan 03：`@excalidraw/excalidraw@0.18.1` public API gap audit

- Status: Accepted
- Date: 2026-08-01
- Decision owner: Drawstuff architecture
- Reference engine: lockfile-resolved `@excalidraw/excalidraw@0.18.1`
- **決策：`minimal patch required`**
- **Plan 04：`Skipped — 不修改 upstream`（2026-08-01 owner 決策，取代上行結論
  的執行；詳見 `plans/04-minimal-upstream-seam.md` 決策紀錄。G1/G2/G4 因保留
  原生 editor UI 而不再需要，G3 為 accepted limitation。本文件其餘內容為
  stock 0.18.1 的稽核事實，維持有效，capability matrix 與 tripwire tests 持續
  守護「只依賴 public API」的邊界。）**

## Context

Plan 02 之後 `apps/web` 只透過 `@drawstuff/excalidraw-adapter` 使用 canvas engine。
Plan 05 的 `WhiteboardController`、Plan 06/07/08 的自訂 toolbar 與 Plan 09 的
collaboration contracts 都必須先知道「哪些能力是 upstream public API、哪些只能靠
private property / DOM selector / polling 取得」，否則 controller contract 會在實作
後才發現要重做，或把既成事實當作 fork 的理由。

本文件是 Plan 03 的決策紀錄：capability matrix、證據、reproduction test 指標、
notification cost 評估與最終決策。

## 證據來源

`opensrc` cache（`~/.opensrc/repos/github.com/excalidraw/excalidraw/`）在本次稽核時
沒有 0.18.1 的 checkout，只有一份會持續前進的 `master` checkout，無法當作 version-pinned
evidence，因此改用**與 lockfile 解析結果同一份的 artifact**作為 primary evidence：

| 證據                                | 路徑                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| 已發佈的 public type declarations    | `node_modules/@excalidraw/excalidraw/dist/types/**`      |
| 未壓縮的 dev bundle（含 module 標頭） | `node_modules/@excalidraw/excalidraw/dist/dev/index.js`  |
|                                     | `node_modules/@excalidraw/excalidraw/dist/dev/chunk-4FTI6OG3.js` |
| 編譯後的 stylesheet                  | `node_modules/@excalidraw/excalidraw/dist/dev/index.css` |

dev bundle 每個 module 前都保留 `// <path>` 標頭，因此可直接對應 upstream repo 內
`packages/excalidraw/` 之下的原始檔路徑。下表 `Upstream source` 欄同時給出 upstream
repo 相對路徑與可重現的 dist 行號，兩者都指向 0.18.1 這一個版本。

## Capability matrix

| # | Capability | Upstream public symbol(s) | Public API? | Upstream source | Verdict |
| - | ---------- | ------------------------- | ----------- | --------------- | ------- |
| 1 | Primary tools（selection/hand/rectangle/diamond/ellipse/arrow/line/freedraw/text/eraser） | `ExcalidrawImperativeAPI.setActiveTool(tool)`、`ToolType` | 是 | `packages/excalidraw/types.ts`（`ToolType`）、`packages/excalidraw/components/App.tsx`（`dist/types/.../components/App.d.ts:401`） | **public API** |
| 2 | Active／locked tool state | `getAppState().activeTool.{type,locked,lastActiveTool,customType}`、`setActiveTool({ type, locked })` | 是 | `packages/excalidraw/types.ts`（`AppState.activeTool`, `dist/types/.../types.d.ts:215`） | **public API** |
| 3 | Style defaults（新 element 預設樣式） | `updateScene({ appState: { currentItem* }, captureUpdate })` | 是 | `packages/excalidraw/components/App.tsx`（`dist/dev/index.js:25932`） | **public API** |
| 4 | Selected element actions：**geometry-free** 樣式（stroke／background／fill／opacity／sloppiness／arrowhead）與刪除 | `getSceneElementsIncludingDeleted()` + `newElementWith()` + `updateScene({ elements, captureUpdate })` | 是 | `packages/excalidraw/element/mutateElement.ts`（`dist/dev/chunk-4FTI6OG3.js:22848`）、`packages/excalidraw/actions/actionProperties.tsx`（`actionChangeStrokeColor`, `dist/dev/index.js:4367`）、`packages/excalidraw/components/App.tsx`（`dist/dev/index.js:25960`） | **public API**（附 accepted limitation，見 §「每次 command 的 O(n) 成本」） |
| 4a | Selected element actions：**text 樣式**（font size／font family／text align），**text 沒有 container** | `newElementWith()` 只改屬性，reflow 要另外用 `restoreElements(elements, null, { repairBindings: true, refreshDimensions: true })` | 是（但沒有等價的 public reflow 路徑） | `packages/excalidraw/actions/actionProperties.tsx`（`changeFontSize`, `dist/dev/index.js:4321`；`actionChangeFontFamily`, `:4824`；`actionChangeTextAlign`, `:5098`）、`packages/excalidraw/data/restore.ts`（`restoreElements`, `dist/dev/chunk-4FTI6OG3.js:20669`、`refreshDimensions` 分支 `:20707`） | **public API（附 accepted limitation）** |
| 4b | Selected element actions：**container-bound text 的 reflow**（依 container 寬度重新 wrap、container 尺寸重算、bound text 重新定位） | 無。`redrawTextBoundingBox` 未 export，`restoreElements` 走的 `refreshTextDimensions` 只重算 text 自身尺寸；重建該行為所需的 helper 全部未 export | **否** | `packages/excalidraw/element/textElement.ts`（`redrawTextBoundingBox`, `dist/dev/chunk-4FTI6OG3.js:14560`）、`packages/excalidraw/element/newElement.ts`（`refreshTextDimensions`, `:15252`） | **confirmed gap（G4）** |
| 5 | Undo／redo | 無。`ExcalidrawImperativeAPI.history` 只有 `clear` | **否** | `packages/excalidraw/types.ts`（`dist/types/.../types.d.ts:608`）、`packages/excalidraw/components/App.tsx`（`dist/dev/index.js:29428`）、`packages/excalidraw/actions/actionHistory.tsx`（`dist/dev/index.js:13728`） | **confirmed gap（G2）** |
| 6 | 隱藏或替換 upstream primary toolbar | 無。`UIOptions` 只有 `canvasActions`／`tools.image`／`dockedSidebarBreakpoint` | **否** | `packages/excalidraw/types.ts`（`UIOptions`, `dist/types/.../types.d.ts:484`）、`packages/excalidraw/components/LayerUI.tsx`（`dist/dev/index.js:21182`） | **confirmed gap（G1）** |
| 6a | 隱藏 selected-shape properties panel | `zenModeEnabled`（CSS translate 出畫面） | 是（但副作用大） | `packages/excalidraw/components/LayerUI.tsx`（`dist/dev/index.js:21141`）、`dist/dev/index.css:5057` | **accepted limitation** |
| 7 | Mobile UI：判斷 mobile breakpoint | `renderTopRightUI(isMobile, appState)`、`useDevice()` | 是 | `packages/excalidraw/components/LayerUI.tsx`（`dist/dev/index.js:21292`）、`packages/excalidraw/components/App.tsx`（`dist/dev/index.js:24682`） | **public API** |
| 7a | Mobile UI：host render slot | `MainMenu`、`renderTopRightUI`、`Sidebar`；`Footer` 只在 desktop 掛載 | 是（受限） | `packages/excalidraw/components/LayerUI.tsx`（`dist/dev/index.js:21427`、`21448`、`16777`）、`packages/excalidraw/components/MobileMenu.tsx`（`dist/dev/index.js:15452`） | **accepted limitation** |
| 8 | Collaboration：peer pointer 進出 | `props.onPointerUpdate`、`updateScene({ collaborators })`、`Collaborator`／`SocketId`／`UserIdleState` | 是 | `packages/excalidraw/components/App.tsx`（`dist/dev/index.js:29335`）、`packages/excalidraw/types.ts`（`dist/types/.../types.d.ts:26`） | **public API**（unthrottled，見 §notification cost） |
| 8a | Collaboration：scene sync 與 reconciliation | `getSceneElementsIncludingDeleted()`、`reconcileElements()`、`getSceneVersion()`、`hashElementsVersion()`、`CaptureUpdateAction.NEVER` | 是 | `packages/excalidraw/data/reconcile.ts`（`dist/dev/index.js:32826`）、`packages/excalidraw/store.ts`（`dist/dev/chunk-4FTI6OG3.js:16706`） | **public API** |
| 8b | Collaboration：follow mode | `props.onUserFollow`、`appState.userToFollow` | 是 | `packages/excalidraw/components/App.tsx`（`dist/dev/index.js:30454-30466`） | **public API** |
| 8c | Collaboration：idle detection | 無。`UserIdleState` 只有 enum，偵測邏輯在 `excalidraw-app`，不在 package | 否（host 自理） | `packages/excalidraw/constants.ts` | **accepted limitation** |
| 9 | Embeddable 網域擴充 | `props.validateEmbeddable`（function 回傳 `undefined` 時退回內建 `ALLOWED_DOMAINS`） | 是 | `packages/excalidraw/element/embeddable.ts`（`dist/dev/chunk-4FTI6OG3.js:17284-17311`） | **public API（no gap）** |
| 9a | Embeddable 拒絕提示文案 | 無。內部直接 `setToast({ message: t("toast.unableToEmbed") })`；`setLanguage`／`t` 皆未 export | **否** | `packages/excalidraw/components/hyperlink/Hyperlink.tsx`（`dist/dev/index.js:8801`）、`packages/excalidraw/i18n.ts`（`dist/dev/index.js:710-830`） | **confirmed gap（G3）** |
| 10 | State change 通知 | `props.onChange` / `ExcalidrawImperativeAPI.onChange` | 是（唯一且粗粒度） | `packages/excalidraw/components/App.tsx`（`dist/dev/index.js:30535-30539`） | **public API**（附 accepted limitation） |

### 逐項說明

**#1／#2 primary tools 與 active/locked state.**
`setActiveTool` 的參數型別為
`({ type: Exclude<ToolType,"image"> } | { type:"image"; insertOnCanvasDirectly? } | { type:"custom"; customType }) & { locked?: boolean }`，
Plan 07 列出的 10 個工具全部落在第一個 branch。`appState.activeTool` 同時提供
`locked` 與 `lastActiveTool`，可以正確表達 one-shot tool 用完返回 selection 的行為，
不需要 app 端另存一份 tool state。

**#3 style defaults.**
`updateScene` 的簽章是 `<K extends keyof AppState>(sceneData: { appState?: Pick<AppState,K> | null; ... })`，
所以可以只送 `currentItemStrokeColor` 這種單一 key 的 patch。實作上
`if (sceneData.elements)` 才會呼叫 `Scene.replaceAllElements`，因此**只改 style
defaults 時不會碰到 elements**，成本為 O(1)。

**#4 selected element actions（geometry-free 樣式與刪除）.**
0.18.1 沒有 export 任何 `actionChangeStrokeColor` 之類的 element action，也沒有
`executeAction`。正確的 public 路徑是自己組 elements：
`getSceneElementsIncludingDeleted()` → `map` → 對被選取的 element 呼叫
`newElementWith(element, patch)` → `updateScene({ elements, captureUpdate: IMMEDIATELY })`。

兩個必須寫進 Plan 05 controller 契約的細節：

1. **一定要用 `getSceneElementsIncludingDeleted()`**。`getSceneElements()` 只回
   non-deleted elements，把它餵回 `updateScene` 會呼叫 `replaceAllElements` 並直接
   丟掉 tombstones，破壞 history 與 collaboration reconciliation。
2. **一定要用 `newElementWith`，不要用 `mutateElement`**。後者雖然也是 public
   export，但會就地 mutate element object，違反 Plan 05「commands 不得直接改寫
   element object」的規定。`newElementWith` 會回傳新物件並自動 bump
   `version`／`versionNonce`／`updated`；沒有實際變更時回傳原物件。

這條路徑對 **stroke／background／fill style／stroke width／stroke style／sloppiness
／opacity／arrowhead** 完全足夠：upstream 自己的 `actionChangeStrokeColor`
（`dist/dev/index.js:4367`）也只是 `changeProperty` + `newElementWith`，沒有任何
後續 geometry 修補，host 端逐字複製即可等價。

**#4 的 delete contract.**
upstream 的 `actionDeleteSelected`（`dist/dev/index.js:1201`）在 `deleteSelectedElements`
（`:1068`）之後還會呼叫 **未 export 的** `fixBindingsAfterDeletion`
（`dist/dev/chunk-4FTI6OG3.js:11604`）。因為那個 helper 拿不到，host 必須自己重現
同一份契約，Plan 05 的 `deleteSelection()` 必須全部滿足：

1. **Tombstone，不得從 array 移除。** 對每個被選取的 element 呼叫
   `newElementWith(element, { isDeleted: true })`。
2. **Container 的 bound text 一起 tombstone。** 任何 `containerId` 指向被刪除
   container 的 text element 也要標記 `isDeleted`，否則 scene 會留下 dangling
   `containerId`（upstream 在 `deleteSelectedElements` 內以
   `isBoundToContainer(el) && selectedElementIds[el.containerId]` 做同一件事）。
3. **清掉指向已刪除 element 的 binding。** 對每個 linear element，若
   `startBinding`／`endBinding` 的 `elementId` 落在 tombstone 集合內就設為 `null`；
   **指向存活 element 的 binding 不得更動**。
4. **把已刪除的 id 從存活 element 的 `boundElements` 陣列移除**（upstream 由
   `BoundElement.unbindAffected`（`chunk-4FTI6OG3.js:11873`）以
   `newBoundElements`（`:11611`，filter 在 `:11615`）完成）。移除必須是 immutable：
   產生新陣列並用 `newElementWith` 換掉存活 element，不得就地 `splice`。
   `boundElements` 為 `null` 的 element 是 no-op，必須保留原物件。
5. **不在 blast radius 內的 element 必須保留 referential identity。**

Reproduction：`it("reproduces the whole delete contract over public API only")`
（刪除 container `rect-1`，涵蓋 1–3、5）與
`it("prunes the survivor's boundElements when a bound child is deleted")`
（刪除 bound child `arrow-1`，涵蓋 4、5）。

**#4a 沒有 container 的 text 樣式（accepted limitation）.**
font size／font family／text align **不是** geometry-free。upstream 的
`changeFontSize`（`dist/dev/index.js:4321`）在 `newElementWith` 之後還會依序呼叫
`redrawTextBoundingBox`（重算 text 的 `width`／`height`／`lineHeight`，必要時連帶調整
container）與 `updateBoundElements`（讓綁在該 text／container 上的 arrow 重新對齊）。
`actionChangeFontFamily`（`:4824`）與 `actionChangeTextAlign`（`:5098`）同樣依賴
`redrawTextBoundingBox`（前者還會等 `document.fonts.load` 完成後再重算一次）。
**`redrawTextBoundingBox` 與 `updateBoundElements` 都沒有 export**，所以 host 只呼叫
`newElementWith(text, { fontSize })` 會得到「字級變了、`width`／`height` 沒變」的
stale geometry。

唯一的 public 替代路徑是 restore：

```ts
restoreElements(nextElements, null, {
  repairBindings: true,
  refreshDimensions: true,
});
```

`refreshDimensions` 分支（`dist/dev/chunk-4FTI6OG3.js:20707`）確實會對 text element
呼叫 `refreshTextDimensions`，但要付三個代價：

1. **`restoreElement` 會重建每一個 element object**（`chunk-4FTI6OG3.js:20449` 的
   `restoreElementWithProperties` 一律回傳新的 spread 物件），因此本文件
   §notification cost 第 4 點「未變更的 element 保留 referential identity」在
   **text 樣式這條路徑上不成立**。
2. **它不會呼叫 `updateBoundElements`**（只做 `repairBoundElement`／
   `repairContainerElement` 這種 reference 修補），所以綁在被改字級的 text 上的
   arrow 幾何仍然是舊的，要等使用者下次拖動該 element 才會被 upstream 修正。
3. **它從 `text` 而不是 `originalText` 重新 wrap，而且完全不碰 container。**
   `refreshTextDimensions`（`:15252`）的 `text` 參數預設為 `textElement.text`，也就是
   **已經被硬換行過的字串**，再 wrap 一次不是 idempotent；同一段文字重複改字級會把
   既有換行點固定下來。它也只回傳 `{ text, ...dimensions }`，不會調整 container 的
   `width`／`height`，更不會重新定位 bound text。這一半的行為就是 **#4b（G4）**。

因此 Plan 08 的 font controls 接受「text 樣式改動後 bound arrow 幾何可能暫時未對齊」
這個 limitation，不得為了修它而去讀 upstream internals。
Reproduction：`describe("text styling (public API with an accepted limitation)")`。

**#4b container-bound text 的 reflow（confirmed gap G4）.**
上面的第 3 點對「沒有 container 的 text」只是精度問題，但對 **container-bound
text**（`containerId` 指向 rectangle／diamond／ellipse 的 text）則是缺一整段行為。
把 upstream 的 `redrawTextBoundingBox`（`chunk-4FTI6OG3.js:14560`）與 restore 路徑的
`refreshTextDimensions`（`:15252`）逐行對照即可看出差距：

| 步驟 | `redrawTextBoundingBox`（upstream action 走的路徑） | `refreshTextDimensions`（restore 走的路徑） |
| ---- | --------------------------------------------------- | ------------------------------------------- |
| wrap 來源 | `wrapText(textElement.originalText, ...)`（`:14574`），每次都從未換行的原文重算 | `wrapText(text, ...)`，`text` 預設 `textElement.text`（`:15252`），從已換行結果再 wrap |
| container 尺寸 | 量出的 `metrics` 超過 `getBoundTextMaxHeight`／`getBoundTextMaxWidth` 時，以 `computeContainerDimensionForBoundText` 放大 container（`:14595`、`:14603`） | 不存在。只回傳 text 自己的 `{ text, ...dimensions }` |
| bound text 位置 | 以 `computeBoundTextPosition(container, updatedTextElement, elementsMap)` 重新對齊（`:14613`） | 不存在 |

要在 host 端補上這段行為，需要 `measureText`／`wrapText`／`getFontString`／
`getBoundTextMaxWidth`／`computeContainerDimensionForBoundText`／
`computeBoundTextPosition`／`getContainerElement`——**這七個 helper 全部不在 root
export**（`element/textMeasurements.ts`、`element/textWrapping.ts`、
`element/textElement.ts` 都沒有被 re-export 到 package entry）。自己重寫等於把
upstream 的 text layout 演算法 copy/paste 一份，正是 Plan 04 In scope 明文禁止的
「copy/paste upstream implementation」，而且一旦 upstream 調整 wrapping 或 padding
就會與 canvas 實際渲染結果不一致。因此列為 **confirmed gap（G4）**。

**public 能做到的一半：修 wrap 來源。** 呼叫 restore 之前先把 `text` 重設回
`originalText`，就能讓 `refreshTextDimensions` 從未換行的原文開始 wrap，消除上面
第 3 點的非 idempotent 問題：

```ts
const nextElements = elements.map((element) =>
  element.id === textId && element.type === "text"
    ? newElementWith(element, { fontSize, text: element.originalText })
    : element,
);
// 接著才走 §#4a 的 restoreElements(nextElements, null, { ... }) recipe
```

**但 container 那一半沒有任何 public 解法。** 沒有 public API 能重算 container 的
`width`／`height`，也沒有 public API 能重新定位 bound text；字級變大後 text 會溢出
未放大的 container，直到使用者手動拖動 container 才由 upstream 修正。
Reproduction：`describe("container-bound text reflow (confirmed gap G4)")`。

**#5 undo／redo（G1 以外最重要的 gap）。**
`History` class 有 `undo()`／`redo()`，`actionUndo`／`actionRedo` 也存在，但
`ExcalidrawImperativeAPI` 只暴露 `history: { clear }`。`registerAction` 可以「註冊」
action 卻無法「執行」action（`ActionManager.executeAction` 不在 public surface）。
唯一剩下的觸發路徑是對 editor container 派送合成 `KeyboardEvent`，屬於 Plan 03
明文禁止的 DOM-level workaround。

**#6 隱藏 upstream primary toolbar.**
`LayerUI` 在 `!appState.viewModeEnabled && appState.openDialog?.name !== "elementLinkSelector"`
時無條件渲染裝著 `ShapesSwitcher` 的 `App-toolbar` island；`UIOptions.tools` 只有
`image` 一個開關。可用的 props 都有副作用：

- `viewModeEnabled`：確實隱藏 toolbar，但同時停用編輯，不可用。
- `zenModeEnabled`：只把 properties panel、top-right UI 與 footer 用 CSS translate
  推出畫面（`.zen-mode-transition.transition-left { transform: translate(-999px,0) }`），
  primary tool island 仍然留在原位；而且 host 自己的 `Footer` slot 內容也會被一起
  往下推 92px（`layer-ui__wrapper__footer-left--transition-bottom`），因此不能拿
  zen mode 當作「顯示自訂 toolbar、隱藏原生 toolbar」的手段。

**#7／#7a mobile.**
`useDevice()` 是 public export，但它讀的是 `DeviceContext`，在 Excalidraw component
subtree 之外會**安靜地**回傳預設值 `{ editor: { isMobile: false }, ... }`。因此
Plan 06 的自訂 toolbar 若要用 `useDevice()`，必須渲染在 `<ExcalidrawCanvas>` 的
children 內；否則要用 `renderTopRightUI(isMobile, appState)` 傳進來的 `isMobile`，
或 app 自己的 media query。

另外 `LayerUI` 只在 `!device.editor.isMobile` 的分支渲染 `Footer`，而
`FooterCenterTunnel.Out` 就在 `Footer` 裡面，所以 **`ExcalidrawFooter` 的 children
在 mobile 完全不會掛載**。Mobile 可用的 host slot 是 `MainMenu`、
`renderTopRightUI` 與 `Sidebar`。

**#9／#9a embeddable。**
與 Plan 03 已預先記錄的結論一致，已逐行覆核：`embeddableURLValidator(url, validateEmbeddable)`
在 `typeof validateEmbeddable === "function"` 且回傳值不是 boolean 時，會往下走到
`return !!matchHostname(url, ALLOWED_DOMAINS)`，所以 host 只加白名單、不會影響既有
網域。本 repo 以 `apps/web/src/config/embed-allowlist.ts` 自管補充名單。

**#9 這一列只有 source-level evidence。** `embeddableURLValidator` 既不在 root
export，upstream export map 的 `./*` subpath 也只宣告 `types` condition（沒有任何
runtime condition），所以它 type 上看得到、runtime 拿不到，reproduction test **無法
實際執行** fall-through 行為，只能 pin「拿不到」這件事本身
（`it("cannot reach embeddableURLValidator from any published entrypoint")`）。
升級 `@excalidraw/excalidraw` 時，這一列必須**人工重讀
`dist/dev/chunk-4FTI6OG3.js` 的 `embeddableURLValidator`** 重新確認，不能只靠測試綠燈。

拒絕提示文案則沒有任何 public 覆寫點：`t` 由 module-private 的 `currentLangData`
解析，`setLanguage` 未 export，`langCode` 只能整包切換官方語系。對 self-hosted SaaS
而言，該文案會把使用者導向 Excalidraw 上游 GitHub 開 issue，而正確動作是改本 repo
的 allowlist 設定檔。

## Notification／render cost 評估

| 候選 API | 觸發時機 | Payload 成本 | 是否需要 polling／full-scene diff | 結論 |
| -------- | -------- | ------------ | --------------------------------- | ---- |
| `props.onChange` / `api.onChange` | `App.componentDidUpdate` **最後一行**，也就是每一次 App re-render（含 pointer move、hover、drag 期間每個 frame、selection change、style change、scroll／zoom） | O(1)：`elements` 直接傳 `Scene.getElementsIncludingDeleted()` 的既有 array reference，`appState` 直接傳 `this.state`，upstream **不複製 scene** | 否 | 唯一可用的 change channel；controller 必須自行做 semantic dedupe |
| `props.onPointerUpdate` | `savePointer()`，由 `handleCanvasPointerMove` 對**每一個原始 pointermove event** 呼叫，未 throttle | O(1) | 否 | 只能用於 presence；host 必須自行 throttle |
| `api.onScrollChange` | 只在 `zoom.value`／`scrollX`／`scrollY` 改變時 | O(1) | 否 | 適合 viewport 同步，不適合 toolbar |
| `api.onPointerDown` / `onPointerUp` | pointer 事件 | O(1) | 否 | 適合手勢，不適合 toolbar state |
| `Store.onStoreIncrementEmitter`（`CaptureUpdate` 機制） | 每次 `store.commit` | 會做 changed-element structural clone | — | **不可用**：`Store`／`IStore` 未 export，且型別標註 `@experimental`。只有 `CaptureUpdateAction` 常數是 public |
| `History.onHistoryChangedEmitter` | undo/redo stack 變動 | O(1) | — | **不可用**：`History` 未 export |

### 對 Plan 05 controller 的硬性要求

1. **不得把 `onChange` 直接轉成 subscriber 通知。** 它是 render-frequency 而非
   change-semantic 的訊號，drag 期間會以 frame rate 觸發。Controller 必須先算出小型
   immutable snapshot（active tool、locked、selection summary），語意相同就不通知。
2. **不得在 `onChange` 內掃描全 scene。** Selection summary 需要
   `elements × selectedElementIds`，請以 `(elements array reference, appState.selectedElementIds reference)`
   兩者的 identity 做 memoization：pointer move 不會換掉這兩個 reference，所以 O(n)
   的比對每次「真的」scene 或 selection 改變才會發生一次。
3. **不得用 `hashElementsVersion(elements)` 當 dirty check。** 它是 O(n)，放在
   `onChange` 等於每個 frame 掃全 scene。若要偵測 in-place mutation，只比對「被選取
   的 k 個 element」的 `versionNonce`（O(k)）。
4. **每次 command 的 O(n) 成本是 accepted limitation。**
   `updateScene({ elements })` 一定要傳完整 array（內部呼叫 `replaceAllElements`），
   並且會做 `syncInvalidIndices`、`arrayToMap`、`filterUncomittedElements`，皆為
   O(n)。這與 upstream 自己執行 action 的成本相同，且只發生在使用者觸發的 command
   上，不在 hot path。搭配 `newElementWith` 的 command（geometry-free 樣式、刪除）
   會讓未變更的 element 保留 referential identity，不會產生 full-scene deep copy。
   **例外：需要 text reflow 的 command**（font size／font family／text align）必須走
   `restoreElements(..., { refreshDimensions: true })`，而 `restoreElement` 會重建
   *每一個* element object，等同一次 full-scene shallow rebuild；詳見 §#4a／§#4b。

### 被否決的設計（不得進入 production）

| 想法 | 否決理由 |
| ---- | -------- |
| 對 `.excalidraw` container 派送合成 `KeyboardEvent` 觸發 undo/redo | DOM-level workaround，Plan 03 明訂為 confirmed gap |
| 用 CSS override（`.App-toolbar { display: none }`）隱藏原生 toolbar | 依賴 upstream class name，屬 undocumented internal |
| 以 `setInterval` 輪詢 `getAppState()` 取得 toolbar state | timer polling，明文禁止 |
| 讀 `appState.toast.message` 與英文原文比對後改寫 toast | 依賴 locale 字面值，脆弱且仍是 undocumented 行為 |
| 讀取 `app.actionManager` / `app.history` 等 private property | undocumented internals |

## Confirmed gaps 與 reproduction test 對照

所有 reproduction 都放在
`packages/excalidraw-adapter/tests/upstream-capability-audit.test.ts`。
記錄 gap 的測試斷言的是**現況**，因此今天會通過，一旦 upstream 補上對應 API 就會
失敗。兩種 tripwire 的偵測範圍不同，**不可混為一談**——尤其是「新增」方向，只有其中
一種抓得到：

- **runtime 斷言（`vitest`）只涵蓋真正的 module namespace。**
  `upstreamExportNames = Object.keys(upstream)` 是在 runtime 讀取實際 module
  exports，所以 `expect(upstreamExportNames).not.toContain(...)` 確實會在 upstream
  **新增 export** 時失敗。
- **但 `editorPropKeys`／`imperativeApiKeys`／`optionKeys` 這類陣列不是 runtime 事實。**
  它們是本檔案手寫維護的 `as const` 陣列（`EDITOR_PROP_KEYS`、`IMPERATIVE_API_KEYS`
  等），upstream 新增一個 prop 並不會讓陣列多一個元素，因此
  `expect(editorPropKeys).not.toContain("renderToolbar")` **永遠是綠的**，抓不到任何
  新增。這些成員的「新增」方向**只由 `assertNoUnauditedKeys` 的 tsc tripwire 負責**。
- **compile-time 斷言（`tsc --noEmit`）**：`as const satisfies readonly (keyof T)[]`
  在 audited 成員**消失**時失敗；`assertNoUnauditedKeys<Exclude<keyof T, audited>>()`
  則在 upstream **新增**成員時失敗（該 helper 的型別參數受 `extends never` 限制，
  只要 `Exclude<...>` 不是 `never` 就無法通過型別檢查）。

因此升級 `@excalidraw/excalidraw` 時**必須同時跑 typecheck 與 tests**，缺一不可：

```sh
pnpm typecheck   # prop/API/UIOptions 等 audited 成員的增減
pnpm --filter @drawstuff/excalidraw-adapter test   # module export 的增減
```

只跑測試會漏掉 upstream 新增 prop／imperative API／`UIOptions` 開關（例如 G1 被補上
的那一天）；只跑 typecheck 則會漏掉 upstream 新增 export（例如 G2 的 `undo`／`redo`
或 G4 的 reflow helper 被 export 的那一天）。

| Gap | 說明 | 阻擋的 plan | Reproduction |
| --- | ---- | ----------- | ------------ |
| **G1** | 沒有隱藏 upstream primary tool island 的 public option | Plan 07（「在 feature flag 下隱藏重複的 upstream primary tool UI」） | `describe("hiding or replacing the upstream toolbar (confirmed gap)")` |
| **G2** | 沒有 host 可呼叫的 undo／redo command | Plan 05（`undo()`／`redo()`）、Plan 08（style update 必須進 history 且可 undo） | `describe("undo/redo (confirmed gap)")` |
| **G3** | 無法覆寫單一 locale key（`toast.unableToEmbed`） | 無（不阻擋，但是產品正確性問題） | `describe("embeddable allowlist (no gap) and its rejection toast (confirmed gap)")` |
| **G4** | 沒有 public 的 container-bound text reflow（container 尺寸重算與 bound text 定位） | Plan 08（font size／font family／text align 套用在 container-bound text 上） | `describe("container-bound text reflow (confirmed gap G4)")` |

證明「public API 足夠」的 spike：

| Capability | Spike |
| ---------- | ----- |
| Primary tools／locked state | `describe("primary tools and active/locked tool state (public API)")` |
| Style defaults | `describe("style defaults (public API)")` |
| Selected element actions（含完整 delete contract） | `describe("selected element actions (public API, O(n) accepted limitation)")` |
| Text 樣式（無 container）與其 reflow limitation | `describe("text styling (public API with an accepted limitation)")` |
| Collaboration state | `describe("collaboration state (public API)")` |
| Mobile 判斷 | `describe("mobile UI (public API with an accepted limitation)")` |
| Notification channel | `describe("change notification cost (accepted limitation)")` |
| Embeddable 網域擴充 | `describe("embeddable allowlist (no gap) ...")` 前兩個 case |

此外 `describe("upstream 0.18.1 public API surface")` 以
`as const satisfies readonly (keyof T)[]` 固定了 25 個 `ExcalidrawImperativeAPI`
成員與 34 個 `ExcalidrawProps` prop，並以 `assertNoUnauditedKeys<...>()` 補上「新增
成員」方向的 tripwire。升級 upstream 時只要 public surface 有增減，`tsc --noEmit`
就會失敗，強迫重跑本稽核。

## 決策

**`minimal patch required`。**

`primary tools`、`active/locked tool state`、`style defaults`、
`selected element actions`、`mobile 判斷`、`collaboration callbacks 所需 state` 與
`embeddable 網域擴充`都只靠 public API 即可完成，`change notification` 有可接受的
public 管道與明確的 dedupe 要求。但 **G1（隱藏 upstream primary toolbar）**、
**G2（undo／redo command）** 與 **G4（container-bound text reflow）** 無法用較小的
product UX 調整消除：

- G1 若不處理，Plan 06/07 開啟 feature flag 時畫面上會同時存在兩套 primary tool
  UI，違反 Plan 08「production bundle 沒有 hidden duplicate controls」。
- G2 若不處理，自訂 toolbar 無法提供 undo／redo，Plan 08「所有修改都進入 upstream
  history，undo/redo 結果正確」無法由 Drawstuff UI 驗收。
- G4 若不處理，Plan 08 的 font controls 套用在 container-bound text 上時，container
  不會跟著放大、text 也不會重新定位，畫面直接出現文字溢出 container 的錯誤結果。
  唯一的替代路徑是 copy/paste upstream 的 text layout 演算法，Plan 04 明文禁止。

因此 Plan 04 標記為 **Ready**，並依 Plan 04「多個不相關 gaps 就分開執行」的規定拆成
四次獨立執行，優先順序依 Plan 04 的 seam 分類：

| 順序 | Gap | Plan 04 seam 類型 | 理由 |
| ---- | --- | ----------------- | ---- |
| 1 | G2 undo／redo | 類型 1：upstream 已存在但未 export 的 stable command | `History.undo/redo` 與 `actionUndo`／`actionRedo` 已存在，只需把 command 掛上 `ExcalidrawImperativeAPI`，不改 engine 行為 |
| 2 | G1 primary toolbar 可見性 | 類型 3：最小 visibility option | 只在 `UIOptions.tools` 加一個開關，`LayerUI` 依此略過 `App-toolbar` island |
| 3 | G3 locale key 覆寫 | 類型 3：最小 visibility／override option | 不阻擋任何 plan，可最後處理 |
| 4 | G4 container-bound text reflow | 類型 1：upstream 已存在但未 export 的 stable command | `redrawTextBoundingBox` 已存在且行為穩定，只需以 command 形式暴露；排在 G3 之後是因為它只影響 Plan 08 的 font controls，且 host 可先用 §#4b 的 `originalText` recipe 涵蓋沒有 container 的 text |

Plan 05 的 controller contract 在 Plan 04 完成 G2 之前，`undo()`／`redo()` 必須標記
為未實作（typed no-op 或不納入第一版），不得先用 DOM workaround 頂替。

## Consequences

- Plan 04 狀態改為 `Ready`，並記錄 G1／G2／G3／G4 四個 seam。
- Plan 05 controller 的 `getSelectionSummary()` 必須採用本文件 §notification cost
  的 memoization 規則，並在 `updateScene` 時使用
  `getSceneElementsIncludingDeleted()` + `newElementWith`。
- Plan 06 的自訂 toolbar 若要用 `useDevice()`，必須渲染在 `<ExcalidrawCanvas>`
  children 內；mobile 版面不能依賴 `ExcalidrawFooter`。
- Plan 09 的 collaboration contracts 不需要任何 upstream seam。
- Plan 08 的 font controls 只能對「沒有 container 的 text」宣告 parity；
  container-bound text 在 Plan 04 完成 G4 之前屬於已知缺陷，不得以 copy/paste
  upstream text layout 的方式先行實作。
- 升級 `@excalidraw/excalidraw` 時，`upstream-capability-audit.test.ts` 的 surface
  tripwire 會強制重新檢視本表；若 upstream 自行補上 G1／G2／G3／G4，對應的 gap 測試
  或 typecheck 會失敗，即為移除 Plan 04 patch 的條件（兩者的分工見 §Confirmed gaps
  與 reproduction test 對照）。
