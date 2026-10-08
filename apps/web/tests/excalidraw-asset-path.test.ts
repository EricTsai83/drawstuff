// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXCALIDRAW_ASSET_PATH,
  installExcalidrawAssetPath,
} from "@/config/excalidraw-asset-path";

import { resolveExcalidrawPackage } from "../scripts/excalidraw-fonts-css.mjs";

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

describe("@excalidraw/excalidraw esm.sh fallback patch", () => {
  // 原因與移除時機見 src/config/excalidraw-asset-path.ts。直接檢查 lockfile
  // 解析出的 dist：ExcalidrawFontFace 沒有公開 export，無法以行為測試。
  const distDir = path.dirname(resolveExcalidrawPackage().fontsDir);
  const chunks = ["dev", "prod"].flatMap((build) => {
    const dir = path.join(distDir, "..", build);
    return readdirSync(dir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(path.join(dir, file), "utf8"))
      .filter((source) => source.includes(".ASSETS_FALLBACK_URL))"));
  });

  it("only appends the CDN fallback when no asset path is configured", () => {
    expect(chunks).toHaveLength(2);
    for (const source of chunks) {
      expect(source).toMatch(
        /if \(urls\.length === 0\) \{\s*urls\.push\(new URL\(assetUrl, _ExcalidrawFontFace\.ASSETS_FALLBACK_URL\)\)|r\.length===0&&r\.push\(new URL\(n,jn\.ASSETS_FALLBACK_URL\)\)/,
      );
    }
  });
});
