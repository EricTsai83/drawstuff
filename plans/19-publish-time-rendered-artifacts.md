# 19 — 公開場景改為「發布時渲染成品」，訪客頁面不再載入引擎

- 前置：[18 — 公開 viewer 字型改走 CSS](18-published-viewer-fonts-via-css.md)（成品 SVG 必須是
  `skipInliningFonts` 版本，否則成品會帶 base64 字型並要求 `font-src data:`）
- 後續：無
- Pattern 文件：[Render once, serve many](../docs/system-design/render-once-serve-many.md)

## 目標

`/p/[slug]` 目前在每個訪客的瀏覽器裡：載入 Excalidraw 引擎 → 解壓場景與檔案 → `exportToSvg`
→ 顯示。已發布的內容只在作者儲存時改變，卻被觀看多次。本 plan 把渲染搬到寫入端：作者的
瀏覽器在儲存／發布時產出淺色與深色兩份 SVG 成品上傳，訪客頁面只下載一個 SVG。訪客頁面
不再載入任何 Excalidraw JS，載入時間與 CSP 暴露面同時縮小，並得到可用的 `og:image`。

## 關鍵設計決策

### D1 — 成品在什麼時候產生

現況：`scene.publish` 是伺服器端把 `isPublished` 設 true 並配 slug（由 `scene-card.tsx` 觸發，
瀏覽器裡沒有場景資料）；`/p` 讀的是**即時** `sceneData`，所以公開頁永遠反映最新一次儲存。

兩個選項：

| 選項 | 成品產生時機 | 公開頁語意 | 代價 |
| --- | --- | --- | --- |
| A. 發布時渲染 | 按「發布」時 | 公開的是「發布當下的版本」；之後儲存不影響公開頁，需「更新公開版本」 | 語意改變；publish 觸發點要拿到場景資料 |
| B. 儲存時渲染 | 每次雲端儲存，且該場景已發布時 | 與現況一致：公開頁反映最新儲存 | 每次儲存多兩個上傳 |

**選 B，並讓 publish 補齊。** 理由：(1) 現有語意不變，作者不需要學新的「發布版本」概念；
(2) `use-cloud-upload.ts` 已在每次雲端儲存後產生並上傳 PNG 縮圖，成品渲染放在同一個
位置，是既有 pattern 的延伸；(3) 首次發布時場景可能還沒有成品（發布前的儲存不渲染），
`scene.publish` 改為兩步：client 先渲染上傳成品，再呼叫 publish 帶上成品 key。發布入口
（`scene-card.tsx`）需要先載入該場景資料才能渲染，這一步的 UX（進度、失敗）要設計。

若之後想要「發布版本」語意（例如草稿與公開版分離），只需停止儲存時渲染，改 A；成品格式
與 viewer 不變。

### D2 — 為什麼是兩份 SVG，不是一份加濾鏡

上游 0.18.1 的深色模式在 SVG 根節點套 `invert(93%) hue-rotate(180deg)`，並對每個 `<image>`
再套反向濾鏡讓照片不變負片。只存淺色版、viewer 自己加根節點濾鏡，照片會變負片；要修就得
把上游深色邏輯抄到 viewer。存兩份，深色版由引擎產生，viewer 只決定載哪一份。多一個
幾十到幾百 KB 的檔案，換 viewer 零特例。

### D3 — 圖片與字型都用網址引用

- 字型：由 plan 18 的 `fonts.css` 提供，成品不內嵌（`skipInliningFonts: true`）。
- 圖片：上游 `exportToSvg` 會把圖片以 data URL 內嵌進 SVG。**第一版接受內嵌**：現有
  `file_record` 是壓縮（可能加密）的 payload，viewer 端解密才能顯示，公開場景的檔案本來就
  隨場景一起送到瀏覽器；成品裡內嵌相當於把「解壓後的圖」存一份。若成品尺寸成為問題
  （含多張大圖的場景），再評估把 `<image href>` 改寫成成品旁的獨立檔案。這是有意識延後的
  決策，記在 Trade-offs。

### D4 — 縮圖

`scene.thumbnail_url` 已存在（儲存時由 `exportSceneThumbnail` 產生），直接拿來當 `og:image`，
**不新增第三個檔案**。若日後需要固定尺寸的社群預覽圖，再加。

## P1 — 資料模型與儲存

檔案：`apps/web/src/server/db/schema.ts`、對應 migration

- `scene` 新增：`published_svg_light_key`、`published_svg_light_url`、
  `published_svg_dark_key`、`published_svg_dark_url`、`published_render_engine_version`
  （字串，來自 `@excalidraw/excalidraw` 的版本）、`published_rendered_at`。
- 成品走現有 uploadthing 路徑（與縮圖相同的 route），檔名含內容雜湊，回應 immutable。
- 生命週期：unpublish、scene 刪除、workspace 刪除、帳號退場都必須把兩個 key 進
  `deferred_file_cleanup` outbox（見 [data-lifecycle](../docs/architecture/data-lifecycle.md)
  「Deferred object cleanup」）。替換成品時，舊 key 在同一交易入 outbox。
- `docs/architecture/data-lifecycle.md` Lifecycle matrix 新增一列「published render artifacts」。

## P2 — 渲染與上傳（client）

檔案：`apps/web/src/hooks/use-cloud-upload.ts`、新模組 `apps/web/src/lib/render-published-artifacts.ts`

- 新模組：輸入 elements／appState／files，輸出 `{ light: Blob, dark: Blob, engineVersion }`。
  兩次 `exportSceneToSvg({ skipInliningFonts: true, exportBackground: true,
  exportWithDarkMode })`，序列化為 `image/svg+xml`。連結硬化（`hardenSvgLinks`）在這裡做一次，
  viewer 不再重做。
- `use-cloud-upload.ts`：雲端儲存成功後，若場景 `isPublished`，在縮圖上傳旁呼叫上述模組並
  上傳兩個檔，成功後呼叫新 mutation `scene.setPublishedArtifacts`。失敗不阻擋儲存（與縮圖
  相同策略），但要記錄並在下次儲存重試。
- 發布入口：`scene.publish` 前先載入場景（owner 讀取現有 API）、渲染、上傳，再 publish 帶
  兩個 key；沒有成品的 publish 請求伺服器端拒絕。`scene-card.tsx` 顯示進度與錯誤。

## P3 — 伺服器端

檔案：`apps/web/src/server/api/routers/scene.ts`

- `publish` input 增加成品 key／url／engineVersion；寫入時同交易處理舊 key 進 outbox。
- 新 `setPublishedArtifacts`（owner only，場景必須 isPublished）。
- `unpublish` 清欄位並入 outbox。
- `getPublishedSceneBySlug` 回傳成品 url；**過渡期**同時回傳現有 `sceneData` 與 `files`
  給 fallback（見 P5）。

## P4 — Viewer 變薄

檔案：`apps/web/src/app/p/[slug]/page.tsx`、`published-scene-viewer.tsx`、
`published-scene-viewer-wrapper.tsx`

- 有成品時：依 `browserActiveTheme` fetch 對應 SVG 文字，`DOMParser` 解析後掛進 stage；
  切換主題就是換載另一份。`readSceneBackdrop`、pan/zoom、雙模式、backdrop 全部沿用。
- 移除 viewer 對 `@drawstuff/excalidraw-adapter/client` 的 import（成品路徑不需要引擎），
  改由 fallback 路徑 dynamic import。確認 `/p` 的 client bundle 不再含 Excalidraw。
- `page.tsx` 的 `generateMetadata` 加 `openGraph.images = [thumbnailUrl]`。
- fetch 成品的網址是 ufs host，已在 `connect-src`；SVG 內嵌圖片為 data URL，已在 `img-src`。

## P5 — 過渡與回填

- 舊的已發布場景沒有成品。`getPublishedSceneBySlug` 回傳 `artifacts: null` 時，viewer 走
  現有的客戶端匯出路徑（保留現有程式碼做 fallback）。
- 回填：作者在工作區開啟已發布場景時，若無成品或 `published_render_engine_version` 落後，
  下次儲存自動產生。另提供一次性 admin 動作列出「已發布但無成品」的場景數量。
- 依專案規則（見 [evolution and cleanup](../docs/system-design/evolution-and-cleanup.md)），
  fallback 是過渡 shim：所有已發布場景都有成品後，刪除 viewer 的客戶端匯出路徑、
  `getPublishedSceneBySlug` 不再回傳 `sceneData`／`files`，並在 CSP 對 `/p` 收緊。

## 驗證

- 已發布場景儲存後，storage 出現兩個新 SVG，DB 欄位更新，舊 key 進 outbox。
- 開 `/p/<slug>`：Network 只有 HTML、app chunks、一個 SVG、fonts.css 與用到的字型檔；
  無 Excalidraw chunk、無 wasm；切換主題只多一個 SVG 請求。
- 深色成品裡的照片不是負片；淺色與深色下元素顏色與編輯器一致。
- unpublish 後成品 key 在 outbox，GC 後 storage 無殘留。
- 無成品的舊場景仍可開，且儲存一次後自動有成品。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。

## Trade-offs（決策紀錄）

- **每次儲存多兩個上傳**（僅已發布場景）。換來公開頁語意不變、訪客零運算。若儲存頻率
  成為問題，改 D1 選項 A，格式不變。
- **成品可能與引擎版本脫節**：引擎升版後舊成品外觀凍結在舊版。以 `engine_version` 欄位偵測
  並在下次儲存重渲染；接受短暫不一致，不做伺服器端批次重渲染。
- **兩份 SVG 儲存翻倍**，換 viewer 端零深色模式特例（D2）。
- **圖片先內嵌**（D3），成品可能達數 MB。有意識延後，觸發條件寫明：任一成品超過約 2 MB
  時重新評估。
- **渲染在作者瀏覽器**：所見即所得、不用伺服器 DOM；代價是無法在伺服器批次重渲染。
  若日後需要，同一個 `render-published-artifacts.ts` 可搬到 headless 環境，資料格式不變。
- **過渡期雙路徑**：viewer 同時有成品路徑與客戶端匯出 fallback。這是 shim，有明確刪除條件。
- **publish 從單一 mutation 變成 client 兩步**：多了失敗模式（渲染失敗、上傳失敗、publish
  失敗）。伺服器端以「無成品即拒絕發布」守住不變式，client 負責重試與訊息。

## 完成條件

- 驗證全部通過，P5 的回填完成且 fallback 路徑已刪除；
- `docs/architecture/data-lifecycle.md`、`web-csp-design.md`、`web-security-headers.md`、
  `static-export-as-read-only-viewer.md` 回寫現況；
- 依 plans/README 完成規則移除本 plan。
