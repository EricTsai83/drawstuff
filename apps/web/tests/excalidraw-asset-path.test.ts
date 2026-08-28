import { afterEach, describe, expect, it } from "vitest";

import {
  EXCALIDRAW_ASSET_PATH,
  installExcalidrawAssetPath,
} from "@/config/excalidraw-asset-path";

afterEach(() => {
  delete window.EXCALIDRAW_ASSET_PATH;
});

describe("installExcalidrawAssetPath", () => {
  it("points excalidraw canvas assets at the app origin", () => {
    installExcalidrawAssetPath();

    // 未設定時 upstream 會 fallback 到 esm.sh；自家 origin 路徑讓 CSP 的
    // font-src/connect-src 'self' 覆蓋字型與 CJK subset 資產（T16 出口收斂）。
    expect(window.EXCALIDRAW_ASSET_PATH).toBe(EXCALIDRAW_ASSET_PATH);
    expect(EXCALIDRAW_ASSET_PATH).toMatch(/^\/[a-z-]+\/$/);
  });
});
