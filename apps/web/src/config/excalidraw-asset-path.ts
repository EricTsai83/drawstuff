// Excalidraw 0.18.1 在 `window.EXCALIDRAW_ASSET_PATH` 未設定時，把 canvas 字型
// 與 CJK subset 資產 fallback 到 https://esm.sh（一條可外連的第三方出口，也是
// CSP enforce 後的功能地雷）。這裡以公開 API 指向自家 origin；靜態資產由
// `scripts/sync-excalidraw-assets.mjs` 在 dev/build 前從套件複製到
// `public/excalidraw-assets/`，版本永遠跟隨 lockfile。
//
// 設了這個路徑之後，upstream 仍會在每個字型來源後面附加 esm.sh 備援（自家
// 網址失敗才使用）。CSP 的 font-src 只允許 'self'，備援永遠被擋；Chrome 卻在
// 建立每個 FontFace 時就對所有來源做 CSP 檢查。Excalidraw 為了按需載入，替每個
// 子集檔建一個 FontFace（Xiaolai 一家就有 209 個），於是每次開編輯器都有約
// 230 筆 (blocked:csp)，淹沒真正的 CSP 違規。
// `patches/@excalidraw__excalidraw@0.18.1.patch` 改成只在沒設路徑時才附加備援，
// 未設路徑的 upstream 預設行為不變。prod chunk 是單行 minified 程式碼，所以
// patch 檔很大，但實際改動只有一處條件判斷。
//
// 移除時機（tests/excalidraw-asset-path.test.ts 會釘住 patch 仍生效）：
// - upstream 提供關閉備援的選項，或設了 EXCALIDRAW_ASSET_PATH 就不再附加
//   esm.sh（`packages/excalidraw/fonts/ExcalidrawFontFace.ts` 的 `createUrls`）；
//   截至 2026-10 的 master 仍無條件附加。
// - 升級 @excalidraw/excalidraw 時 patch 套用失敗：先確認 upstream 是否已修，
//   已修就刪除 patch 與 pnpm-workspace.yaml 的 patchedDependencies，否則對新
//   版本重做。

export const EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | readonly string[];
  }
}

// upstream 於字型實際載入時才讀取這個值；在任何會觸發字型載入的進入點
// （workspace 的 excalidraw-client-wrapper）的 module scope 呼叫即足夠早。
// /p/[slug] 不載入引擎（只下載發布時渲染好的成品 SVG），不需要呼叫。
export function installExcalidrawAssetPath(): void {
  if (typeof window !== "undefined") {
    window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
  }
}
