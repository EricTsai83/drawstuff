// 把 @excalidraw/excalidraw 的 canvas 字型複製到 public/excalidraw-assets/，
// 讓 `window.EXCALIDRAW_ASSET_PATH`（src/config/excalidraw-asset-path.ts）指向
// 自家 origin，讓正常路徑不再觸及 upstream 的 esm.sh fallback（threat model
// T16/P3.0；上游仍把 esm.sh 掛在候選清單最後，僅在自託管 fetch 失敗時嘗試，
// enforce CSP 下該錯誤路徑會被擋下）。
// 於 `dev`/`build` script 前執行；輸出目錄不進 git，版本永遠跟隨 lockfile。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// @excalidraw/excalidraw 是 excalidraw-adapter 的依賴，從該 workspace 解析，
// 確保複製的版本與實際 bundle 進 app 的版本一致。
const adapterRequire = createRequire(
  path.join(webRoot, "..", "..", "packages", "excalidraw-adapter", "index.js"),
);
// exports map 不開放 ./package.json，改由 main entry（dist/prod/index.js）定位。
const entry = adapterRequire.resolve("@excalidraw/excalidraw");
const packageRoot = path.join(path.dirname(entry), "..", "..");
const version = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;

const sourceFontsDir = path.join(packageRoot, "dist", "prod", "fonts");
if (!existsSync(sourceFontsDir)) {
  throw new Error(
    `sync-excalidraw-assets: fonts directory not found at ${sourceFontsDir}`,
  );
}

const targetDir = path.join(webRoot, "public", "excalidraw-assets");
const versionMarker = path.join(targetDir, ".excalidraw-version");

if (
  existsSync(versionMarker) &&
  readFileSync(versionMarker, "utf8") === version &&
  existsSync(path.join(targetDir, "fonts"))
) {
  process.exit(0);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceFontsDir, path.join(targetDir, "fonts"), { recursive: true });
writeFileSync(versionMarker, version);
console.log(
  `sync-excalidraw-assets: copied @excalidraw/excalidraw@${version} fonts to public/excalidraw-assets/`,
);
