// 把 @excalidraw/excalidraw 的 canvas 字型複製到 public/excalidraw-assets/，
// 讓 `window.EXCALIDRAW_ASSET_PATH`（src/config/excalidraw-asset-path.ts）指向
// 自家 origin，讓正常路徑不再觸及 upstream 的 esm.sh fallback（threat model
// T16/P3.0；上游仍把 esm.sh 掛在候選清單最後，僅在自託管 fetch 失敗時嘗試，
// enforce CSP 下該錯誤路徑會被擋下）。
// 複製後再從這批 woff2 產生 public/excalidraw-assets/fonts.css（每檔一條帶
// unicode-range 的 @font-face），給 /p/[slug] 以 skipInliningFonts 匯出的 SVG
// 使用（scripts/excalidraw-fonts-css.mjs）。
// 於 `dev`/`build` script 前執行；輸出目錄不進 git，版本永遠跟隨 lockfile。

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCanvasFontFaces,
  buildFontsCss,
  readCanvasFontFaces,
  resolveExcalidrawPackage,
} from "./excalidraw-fonts-css.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(scriptsDir, "..");
const { version, fontsDir: sourceFontsDir } = resolveExcalidrawPackage();

// 標記同時綁定套件版本與兩個 script 本身：改了 fonts.css 的產生規則、URL
// 前綴或複製邏輯都要重產，否則 dev 機器上的舊產物會一直活到下次套件升版。
const generatorHash = createHash("sha256")
  .update(readFileSync(path.join(scriptsDir, "excalidraw-fonts-css.mjs")))
  .update(readFileSync(path.join(scriptsDir, "sync-excalidraw-assets.mjs")))
  .digest("hex")
  .slice(0, 16);
const markerValue = `${version}\n${generatorHash}`;

const targetDir = path.join(webRoot, "public", "excalidraw-assets");
const targetFontsDir = path.join(targetDir, "fonts");
const fontsCssPath = path.join(targetDir, "fonts.css");
const versionMarker = path.join(targetDir, ".excalidraw-version");

if (
  existsSync(versionMarker) &&
  readFileSync(versionMarker, "utf8") === markerValue &&
  existsSync(targetFontsDir) &&
  existsSync(fontsCssPath)
) {
  process.exit(0);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceFontsDir, targetFontsDir, { recursive: true });

const faces = readCanvasFontFaces(targetFontsDir);
assertCanvasFontFaces(faces);
writeFileSync(fontsCssPath, buildFontsCss(faces, "/excalidraw-assets/fonts"));

// 標記最後寫：中途失敗（例如 fontkit 解析錯誤）下次會整份重做。
writeFileSync(versionMarker, markerValue);
console.log(
  `sync-excalidraw-assets: copied @excalidraw/excalidraw@${version} fonts and wrote fonts.css (${faces.length} faces) to public/excalidraw-assets/`,
);
