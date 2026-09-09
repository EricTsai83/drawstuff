# 以引擎的靜態匯出當唯讀 Viewer：隱含依賴、保真設定與手勢層

> **Pattern 一句話**：唯讀頁面不掛編輯器，改渲染引擎的**靜態匯出物**（SVG）再自己補平移縮放。
> 代價是匯出流程的隱含依賴（字型、wasm、CSP）與編輯器的保真設定（背景、主題）全部變成
> 你的責任，而且失敗多半是**靜默降級**而不是錯誤——必須驗證產物本身，不能只看呼叫有沒有
> throw。

## 問題

公開分享、embed、預覽等唯讀場景，掛完整編輯器成本太高（bundle、記憶體、要餵一份唯讀的
互動狀態）。引擎通常有 `exportToSvg` 一類的靜態匯出 API，拿它渲染再套一層 CSS transform
就是一個 viewer。但接下來三類問題會在 production 才浮現，而且都不報錯：

1. **匯出物在編輯器裡「順便」成立的前提，在 viewer 裡不成立。** 編輯器 mount 時把字型註冊進
   `document.fonts`，匯出的 SVG 文字因此正常；viewer 沒有編輯器，文字只能靠匯出流程**內嵌**
   的 `@font-face`。而內嵌流程走 WebAssembly（字型子集化），受頁面 CSP 管；一失敗，引擎不
   throw，把來源退回第三方 CDN URL，再被 `font-src` 擋下——結果是系統字型，沒有任何錯誤。
2. **保真設定被當成樣式決策。** 「不要匯出背景，讓頁面主題色當底」看起來只是視覺選擇，實際
   丟掉了編輯器裡「元素顏色相對於場景背景」的對比關係：深色場景上的淺色線條在淺色頁面上消失。
3. **效能提示與畫質互斥。** `will-change: transform` 讓平移縮放留在 compositor，但被提升的
   layer 只點陣化一次、之後純 bitmap 縮放；向量文字放大後就糊。永遠開著就是永遠糊。

## Pattern

### 1. 把匯出流程的隱含依賴列成清單，並驗證產物

```mermaid
flowchart LR
    EXP["exportToSvg(elements)"] --> FONT["字型子集化<br/>fetch woff2 → wasm subset → data URL"]
    FONT -->|成功| INLINE["@font-face src: data:"]
    FONT -->|"失敗（被吃掉）"| FALLBACK["@font-face src: https://cdn/…"]
    FALLBACK --> CSP["font-src 'self' 擋下"] --> SYS["系統字型（無錯誤）"]
    INLINE --> OK["與編輯器一致"]
```

做法：

- **枚舉依賴**：匯出流程碰到的每個「環境能力」——網路（字型 URL 是否自託管）、wasm（CSP
  `script-src` 要 `'wasm-unsafe-eval'`）、內嵌字型（`font-src data:`，因為匯出物把字型寫成
  data URL）、worker（`worker-src`）、圖片來源（`img-src data:`）。
  每一項對應到 CSP 或部署設定裡的一行，並在該行註解寫明是誰需要。
- **驗證產物而非呼叫**：對匯出物做結構性斷言——`<style>` 裡的 `src` 必須是 `data:`、不得出現
  第三方 host；文字元素數量與輸入相符。把它放進走查清單，且**在 production 等價的 CSP 下**
  跑（dev 常因 `'unsafe-eval'` 而掩蓋 wasm 問題）。
- **對「引擎自己的 fallback」保持懷疑**：能吃錯誤再退回 CDN 的程式庫，在 CSP 收斂後其 fallback
  形同壞掉；你的 fallback（例如 `skipInliningFonts`）根本不會被觸發。

### 1b. 宣告從出貨資產推導，不從引擎內部借

引擎的字型載入常靠內部類別（註冊 FontFace、附 unicode-range），套件不一定公開。別因此
把「引擎沒公開」等同「做不到」：家族名稱在字型檔的 name table、涵蓋字元在 cmap table，
都是**出貨資產本身的內容**。build 時解析這些檔案產生一份 `fonts.css`，匯出時關掉內嵌
（`skipInliningFonts`），頁面載入 CSS，瀏覽器就用原生的 unicode-range 按需載入。這比等引擎
公開 API 穩：引擎改變註冊方式不影響你，資料來源永遠是你已經自託管的那批檔案。
代價是多一個 build 期解析步驟，以及 cmap 算出的範圍可能比引擎手寫的略寬（多抓一個小檔）。

### 2. 保真設定以「重現編輯器」為準，不以頁面樣式為準

匯出 API 的選項（背景、主題濾鏡、frame 裁切、embed 是否渲染）每一個都是編輯器行為的
子集開關。預設策略：**照編輯器的做**——背景要匯出，viewport 再讀取匯出物裡的背景色補滿
SVG 以外的區域。注意主題濾鏡的位置：引擎可能把 dark mode 當成 SVG 根節點上的 CSS
`filter`，背景矩形保留的是**原色**；直接拿原色鋪 viewport 會在深色主題下得到白底。正確做法
是把矩形的 fill 與根節點的 filter 一起讀回，鋪在 SVG 後面的一層 backdrop 上並套同一個
filter——顏色與濾鏡都來自匯出物本身，不在自己這邊重算色彩。只有在確定不影響元素可辨識性
時才偏離，並把理由寫在選項旁邊。

### 3. 效能提示只在手勢期間開

`will-change` 一類的 compositor 提示，改成**手勢範圍**：pointerdown／wheel 開始時加上、
所有 pointer 放開且 wheel 停止一段 idle 後移除。瀏覽器會在移除時以最終比例重新點陣化，
兼得平移時的流暢與靜止時的清晰。wheel 沒有結束事件，用短 idle timer 收斂。

### 4. 靜態產物上的互動要有模式，而不是一律攔截

匯出的 SVG `<text>` 是真 DOM，拖拉平移會同時觸發瀏覽器文字選取。不要用全域
`user-select: none` 一刀砍——那也砍掉「複製圖上文字」這個唯讀頁最有價值的能力。改成兩個
明確模式（比照編輯器的 hand／selection 工具與快捷鍵）：

| 模式 | 拖拉 | 文字選取 | 滾輪／pinch |
| --- | --- | --- | --- |
| Hand | 平移 | 關（`select-none`） | 縮放 |
| Select | 不處理（交給瀏覽器選字） | 開 | 縮放 |

觸控是例外：觸控沒有「拖拉選字」，所以兩個模式下觸控都保留平移與 pinch。按住 Space
臨時切回平移，與編輯器一致。

## 評估

適用於任何「以第三方引擎的靜態匯出當唯讀畫面」的場景（圖表、公式、地圖、文件預覽）。
核心判準是：**匯出流程在編輯器裡有哪些前提是被順便滿足的？**把答案列出來，就是 viewer
的依賴清單與走查清單。

## Trade-offs

- 靜態匯出無法呈現 iframe／embed 類元素（引擎只畫佈局框加連結）；需要時只能掛編輯器。
- 手勢範圍的 `will-change` 在手勢結束時多一次重新點陣化；大型場景會有一次可見的閃動。
- 「照編輯器的做」意味 viewport 外圍會出現場景背景色而非頁面主題色；這是刻意的。

## 本專案中的實例

- viewer：`apps/web/src/components/excalidraw/published-scene-viewer.tsx`（模式切換、背景讀取、
  `exportBackground: true`）；手勢層：`src/hooks/excalidraw/use-svg-pan-zoom.ts`
  （`panEnabled`、手勢範圍的 `will-change`）；純函式測試 `tests/svg-pan-zoom.test.ts`。
- 字型管線成本：每次開頁（與每次切換主題）都重跑「fetch 子集檔 → wasm 子集化 → 內嵌」，
  中文場景約 50 個 Xiaolai 子集檔、約 3 MB、主執行緒約 1 秒。`next.config.ts` 對內容雜湊
  檔名的字型加 `immutable` 快取，回訪不再打網路。這條管線是上游為「自包含匯出檔」設計的，
  編輯器本身從不走它：編輯器用 FontFace API 註冊帶 unicode-range 的自託管字型，由瀏覽器
  按需載入。viewer 不需要上游的 `Fonts` 類別也能做到同一件事：家族名稱與 unicode-range 都
  在 woff2 的 name／cmap table 裡，由 sync script 在 build 時讀出來產生 `fonts.css`，匯出改
  `skipInliningFonts: true`，頁面載入該 CSS 即可。wasm、`font-src data:` 隨之從訪客頁面消失。
  再進一步是把同一個匯出從觀看時搬到發布時，存成品給訪客。
- CSP 依賴：`src/config/security-headers.ts` 的 `'wasm-unsafe-eval'` 與 `font-src data:`，推導見
  [web-csp-design](../architecture/web-csp-design.md)；字型自託管見
  `scripts/sync-excalidraw-assets.mjs` 與 [web-security-headers](../operations/web-security-headers.md)。
- 後續方向：[Render once, serve many](./render-once-serve-many.md)（把渲染從觀看時搬到寫入端），
  對應 [plans/18](../../plans/18-published-viewer-fonts-via-css.md) 與
  [plans/19](../../plans/19-publish-time-rendered-artifacts.md)。
- 相關 pattern：[第三方引擎的 Adapter 邊界](./third-party-engine-adapter.md)、
  [CSP 與 Code Delivery](./csp-and-code-delivery.md)。
