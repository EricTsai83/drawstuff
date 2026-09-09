# 18 — 公開 viewer 字型改走 CSS `@font-face`，訪客頁面移除 wasm

- 前置：無
- 後續：[19 — 發布時渲染成品](19-publish-time-rendered-artifacts.md)（本 plan 決定成品的字型格式，須先完成）
- Pattern 文件：[以引擎的靜態匯出當唯讀 Viewer](../docs/system-design/static-export-as-read-only-viewer.md) §1b

## 目標

`/p/[slug]` 目前借用 Excalidraw 的匯出字型管線在**觀看時**渲染：抓字型子集檔 → harfbuzz
wasm 裁字 → base64 內嵌進 SVG。實測中文場景每次開頁約 52 次 fetch、首次約 2.9 MB、
主執行緒約 1.1 秒，切換主題再跑一次；為此 CSP 放行了 `'wasm-unsafe-eval'` 與 `font-src data:`。

改成瀏覽器原生的字型載入：build 時從套件出貨的 woff2 產生一份帶 `unicode-range` 的
`fonts.css`，匯出時 `skipInliningFonts: true`，頁面載入該 CSS。結果是訪客頁面零字型運算、
只下載文字實際用到的檔案、字型跨場景共用快取，並把 `font-src data:` 從 CSP 移除。

## 為什麼不是等上游 `export { Fonts }`

上游 master 已公開 `Fonts.loadElementsFonts`，但 npm 最新 0.18.1 沒有。本 plan 不依賴它：
家族名稱在 woff2 的 name table、涵蓋字元在 cmap table，都是出貨資產本身的內容，不是上游
內部程式碼。這樣也不會因為上游改變 FontFace 註冊方式而受影響。

## P1 — sync script 產生 `fonts.css`

檔案：`apps/web/scripts/sync-excalidraw-assets.mjs`

- 新增 dev dependency `fontkit`（支援 woff2 解析）。
- 複製字型後，遍歷 `public/excalidraw-assets/fonts/**/*.woff2`，對每個檔讀出：
  `font.familyName`（name table）、`font.characterSet`（cmap codepoints）。
- 把 codepoints 壓成 `U+XXXX-YYYY, U+ZZZZ` 區間，產生一條 `@font-face`：
  `font-family`、`src: url("/excalidraw-assets/fonts/<dir>/<file>") format("woff2")`、
  `unicode-range`、`font-display: block`（避免字型到達前先以系統字型閃一次）。
- 輸出 `public/excalidraw-assets/fonts.css`，與字型檔一樣不進 git、跟 `.excalidraw-version`
  標記一起判斷是否需要重產。
- 家族名稱以字型檔內部為準（`Comic Shanns`、`Lilita One`、`Liberation Sans` 與資料夾名不同）。
  Helvetica 上游為 `local()`，無檔案，不列。
- 產出後做結構檢查：每條規則都有非空 `unicode-range`；家族集合必須包含
  `Excalifont`、`Xiaolai`、`Virgil`，否則 script 失敗（防止 fontkit 解析失敗時靜默產出空檔）。

## P2 — viewer 改用 CSS 字型

檔案：`apps/web/src/components/excalidraw/published-scene-viewer.tsx`、`apps/web/src/app/p/[slug]/`

- `exportSceneToSvg` 加 `skipInliningFonts: true`；刪除「內嵌失敗就重試 skipInliningFonts」
  的 try/catch 與註解，它已是唯一路徑。
- `/p/[slug]` 加 `layout.tsx`（或在 page 的 `<head>`）載入
  `<link rel="stylesheet" href="/excalidraw-assets/fonts.css">`。不要放在 root layout：工作區
  由上游 FontFace API 自行載入，重複宣告無害但多餘。
- loading 狀態改為等到 `document.fonts.ready` 再淡入 stage，避免 fallback 字型閃動。
- `installExcalidrawAssetPath()` 保留：即使不內嵌，上游仍可能在其他路徑讀取此設定。

## P3 — CSP 與快取收斂

檔案：`apps/web/src/config/security-headers.ts`、`apps/web/next.config.ts`、
`apps/web/tests/security-headers.test.ts`

- `font-src` 回到 `'self'`，測試同步。
- `'wasm-unsafe-eval'` **保留**：工作區的下載 SVG／PNG 仍走上游匯出管線。在
  `security-headers.ts` 更新註解，標明使用者現在只剩工作區匯出，`/p` 不再依賴。
  是否對 `/p/*` 發一份更緊的 per-route CSP，另開決策，不在本 plan。
- `next.config.ts` 現有的字型 immutable 快取規則延伸到 `fonts.css`：它內容隨字型檔變動，
  但沒有雜湊檔名，因此**不能** immutable；維持 Next 預設 `max-age=0` 加 ETag 即可。

## P4 — 測試與文件

- 新增 `apps/web/tests/excalidraw-fonts-css.test.ts`：對一個最小 woff2 fixture（或直接對
  sync 產物）驗證 script 的 CSS 產生函式：unicode-range 壓縮正確、家族名稱來自字型檔、
  Helvetica 不出現。
- `docs/operations/web-security-headers.md`：`font-src` 回 `'self'`，說明字型改由 CSS 宣告。
- `docs/architecture/web-csp-design.md`：刪除「font-src 為什麼需要 data:」一節，改為
  一句記錄它曾經需要且為何不再需要。
- `docs/system-design/static-export-as-read-only-viewer.md`：§1 依賴清單移除 wasm 與 data:，
  §1b 已描述本做法。

## 驗證

- `pnpm dev` 後 `public/excalidraw-assets/fonts.css` 存在，Xiaolai 209 條、Excalifont 7 條。
- 開 `/p/<slug>`（含中文的場景）：`document.fonts.check("16px Excalifont")` 與
  `document.fonts.check("16px Xiaolai", "外")` 皆 `true`；Network 只出現文字用到的字型檔；
  `performance.getEntriesByType("resource")` 無 `subset-worker`／wasm 相關項目；
  切換主題不再下載任何字型；`<style class="style-fonts">` 內容為空。
- 工作區「下載 SVG」仍可用且字型內嵌（`'wasm-unsafe-eval'` 未受影響）。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。

## Trade-offs（決策紀錄）

- **多一個 build 期依賴（fontkit）與解析步驟**，build 多一兩秒。換得字型管線不再依賴
  上游任何內部 API。
- **unicode-range 由 cmap 計算**，可能比上游手寫略寬，最壞情況多下載一個約 57 KB 的檔。
  接受，因為正確性由字型檔本身保證。
- **字型替換閃動**：改用網址載入後，字型到達前文字可能以系統字型短暫顯示。以
  `font-display: block` 加等待 `document.fonts.ready` 處理，代價是首次顯示稍晚。
- **兩套登錄方式並存**：編輯器用上游 FontFace API，viewer 用我們產的 CSS。資料來源是同一批
  檔案，上游改切檔方式時 CSS 自動跟上；但這是兩條路徑，文件必須寫明。
- **不移除 `'wasm-unsafe-eval'`**：工作區匯出仍需要。若要收緊，需 per-route CSP，另開決策。

## 完成條件

- 驗證全部通過；
- P4 文件回寫完成；
- 依 plans/README 完成規則移除本 plan。
