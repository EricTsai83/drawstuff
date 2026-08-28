// Excalidraw 0.18.1 在 `window.EXCALIDRAW_ASSET_PATH` 未設定時，把 canvas 字型
// 與 CJK subset 資產 fallback 到 https://esm.sh（一條可外連的第三方出口，也是
// CSP enforce 後的功能地雷）。這裡以公開 API 指向自家 origin；靜態資產由
// `scripts/sync-excalidraw-assets.mjs` 在 dev/build 前從套件複製到
// `public/excalidraw-assets/`，版本永遠跟隨 lockfile。

export const EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | readonly string[];
  }
}

// upstream 於字型實際載入時才讀取這個值；在任何會觸發字型載入的進入點
// （workspace 的 excalidraw-client-wrapper、/p/[slug] 的 published-scene-viewer）
// 的 module scope 呼叫即足夠早。
export function installExcalidrawAssetPath(): void {
  if (typeof window !== "undefined") {
    window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
  }
}
