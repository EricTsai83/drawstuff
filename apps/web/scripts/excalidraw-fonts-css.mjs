// 從 @excalidraw/excalidraw 出貨的 woff2 產生 `fonts.css`：每個檔案一條
// `@font-face`，`unicode-range` 由字型檔的 cmap table 算出。/p/[slug] 的靜態
// viewer 以 `skipInliningFonts: true` 匯出後載入這份 CSS，字型由瀏覽器原生的
// unicode-range 機制按需載入，訪客頁面不再跑上游的 wasm 子集化管線
// （docs/system-design/static-export-as-read-only-viewer.md §1b）。
//
// 純函式（unicode-range 壓縮、CSS 組裝、結構檢查）與 IO（fontkit 讀檔）分開，
// 讓 tests/excalidraw-fonts-css.test.ts 可以對套件目錄直接驗證。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

/**
 * 定位實際 bundle 進 app 的 @excalidraw/excalidraw：它是 excalidraw-adapter 的
 * 依賴，從該 workspace 解析。exports map 不開放 ./package.json，改由 main
 * entry（dist/prod/index.js）定位套件根目錄。
 * @returns {{ version: string, fontsDir: string }}
 */
export function resolveExcalidrawPackage() {
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const adapterRequire = createRequire(
    path.join(
      webRoot,
      "..",
      "..",
      "packages",
      "excalidraw-adapter",
      "index.js",
    ),
  );
  const entry = adapterRequire.resolve("@excalidraw/excalidraw");
  const packageRoot = path.join(path.dirname(entry), "..", "..");
  const fontsDir = path.join(packageRoot, "dist", "prod", "fonts");
  if (!existsSync(fontsDir)) {
    throw new Error(
      `excalidraw-fonts-css: fonts directory not found at ${fontsDir}`,
    );
  }
  /** @type {{ version: string }} */
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  return { version: manifest.version, fontsDir };
}

/**
 * 出貨資料夾 → 匯出 SVG 裡 `font-family` 使用的家族名稱。
 *
 * 名稱必須等於上游公開的 `FONT_FAMILY` key（加上 CJK fallback 家族 `Xiaolai`），
 * 因為那才是 `<text font-family="Excalifont, Xiaolai, Segoe UI Emoji">` 實際請求
 * 的字串；woff2 的 name table 對其中四個家族不同（`Cascadia Code`、
 * `Comic Shanns Regular`、`Nunito ExtraLight Medium`、`Xiaolai SC`），不能拿來當
 * `font-family`。`Helvetica` 是 `local()`，沒有檔案，不列。
 *
 * 這張表由測試釘住必須等於上游 `FONT_FAMILY` 的 key 集合（減 Helvetica、加
 * Xiaolai），上游新增或改名家族時測試會失敗，而不是 viewer 靜默落到系統字型。
 */
export const CANVAS_FONT_FAMILY_BY_DIR = Object.freeze({
  Cascadia: "Cascadia",
  ComicShanns: "Comic Shanns",
  Excalifont: "Excalifont",
  Liberation: "Liberation Sans",
  Lilita: "Lilita One",
  Nunito: "Nunito",
  Virgil: "Virgil",
  Xiaolai: "Xiaolai",
});

/**
 * 出貨但不是畫布字型的資料夾：Assistant 是編輯器 UI 字型，由上游 index.css 自行
 * 以 `url(./fonts/Assistant/…)` 載入，匯出 SVG 從不引用。
 */
const NON_CANVAS_FONT_DIRS = Object.freeze(["Assistant"]);

/** fontkit 解析失敗時會回傳空 cmap；這些家族缺任何一個就代表產物不可用。 */
const REQUIRED_FAMILIES = ["Excalifont", "Xiaolai", "Virgil"];

/**
 * @typedef {object} FontFaceSource
 * @property {string} family  CSS `font-family`（上游 FONT_FAMILY key）
 * @property {string} dir     `fonts/` 底下的資料夾名
 * @property {string} file    woff2 檔名
 * @property {number} weight  OS/2 usWeightClass；上游對 Nunito 註冊 500，其餘 400
 * @property {string} unicodeRange  已壓縮的 `U+XXXX-YYYY, U+ZZZZ`
 */

/**
 * 把 codepoint 集合壓成 CSS `unicode-range` 值；連續區段合併成 `U+start-end`。
 * @param {Iterable<number>} codePoints
 * @returns {string}
 */
export function formatUnicodeRange(codePoints) {
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b);
  /** @type {string[]} */
  const ranges = [];
  let start = Number.NaN;
  let end = Number.NaN;
  const flush = () => {
    if (Number.isNaN(start)) return;
    // CSS 語法：`U+0141-0142`，區段結尾不重複 `U+`。
    ranges.push(
      start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`,
    );
  };
  for (const codePoint of sorted) {
    if (codePoint === end + 1) {
      end = codePoint;
      continue;
    }
    flush();
    start = codePoint;
    end = codePoint;
  }
  flush();
  return ranges.join(", ");
}

/** @param {number} codePoint */
function hex(codePoint) {
  return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * 遍歷 `fontsDir` 底下每個畫布字型檔，讀出 cmap 與 weight。
 * 未知資料夾一律報錯：上游新增家族時必須先決定它要不要進 CSS。
 * @param {string} fontsDir  複製後的 `public/excalidraw-assets/fonts` 或套件的 `dist/prod/fonts`
 * @returns {FontFaceSource[]}
 */
export function readCanvasFontFaces(fontsDir) {
  /** @type {FontFaceSource[]} */
  const faces = [];
  const dirs = readdirSync(fontsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of dirs) {
    if (NON_CANVAS_FONT_DIRS.includes(dir)) continue;
    const family = /** @type {Record<string, string>} */ (
      CANVAS_FONT_FAMILY_BY_DIR
    )[dir];
    if (!family) {
      throw new Error(
        `excalidraw-fonts-css: unmapped font directory "${dir}"; add it to CANVAS_FONT_FAMILY_BY_DIR or NON_CANVAS_FONT_DIRS`,
      );
    }
    const files = readdirSync(path.join(fontsDir, dir))
      .filter((file) => file.endsWith(".woff2"))
      .sort();
    /** @type {Array<{ file: string, weight: number, codePoints: Set<number> }>} */
    const parsed = [];
    for (const file of files) {
      const font = fontkit.openSync(path.join(fontsDir, dir, file));
      if (!("characterSet" in font)) {
        throw new Error(
          `excalidraw-fonts-css: ${dir}/${file} is a font collection, expected a single face`,
        );
      }
      parsed.push({
        file,
        weight: font["OS/2"].usWeightClass,
        codePoints: new Set(font.characterSet),
      });
    }

    // 認領以家族為單位，前提是同一家族只有一種字重；上游若開始出貨多字重，
    // 認領必須改成以 (family, weight) 為 key，否則另一字重的子集會被扣光。
    const weights = new Set(parsed.map((face) => face.weight));
    if (weights.size > 1) {
      throw new Error(
        `excalidraw-fonts-css: ${dir} ships multiple weights (${[...weights].join(", ")}); code-point claiming must become per-weight before this can be emitted`,
      );
    }

    // 同家族子集的 cmap 會重疊（Google Fonts 切檔把 U+0041 等放進每個子集），而
    // @font-face 對同一 codepoint 是後宣告者勝，會讓純拉丁文字抓到字母序最後的
    // 檔案。改成「大子集先認領，後面的扣掉已認領的 codepoint」，每個 codepoint
    // 只屬於一條規則，瀏覽器只抓一個檔；被完全涵蓋的子集直接略過。
    parsed.sort(
      (a, b) =>
        b.codePoints.size - a.codePoints.size || a.file.localeCompare(b.file),
    );
    const claimed = new Set();
    for (const { file, weight, codePoints } of parsed) {
      const own = [...codePoints].filter((cp) => !claimed.has(cp));
      if (own.length === 0) continue;
      for (const cp of own) claimed.add(cp);
      faces.push({
        family,
        dir,
        file,
        weight,
        unicodeRange: formatUnicodeRange(own),
      });
    }
  }

  for (const dir of Object.keys(CANVAS_FONT_FAMILY_BY_DIR)) {
    if (!dirs.includes(dir)) {
      throw new Error(
        `excalidraw-fonts-css: expected font directory "${dir}" is missing from ${fontsDir}`,
      );
    }
  }

  return faces;
}

/**
 * 產出前的結構檢查：每條規則都要有非空 unicode-range，且必要家族都在。
 * @param {readonly FontFaceSource[]} faces
 */
export function assertCanvasFontFaces(faces) {
  const empty = faces.filter((face) => face.unicodeRange === "");
  if (empty.length > 0) {
    throw new Error(
      `excalidraw-fonts-css: empty unicode-range for ${empty
        .map((face) => `${face.dir}/${face.file}`)
        .join(", ")}`,
    );
  }
  const families = new Set(faces.map((face) => face.family));
  const missing = REQUIRED_FAMILIES.filter((family) => !families.has(family));
  if (missing.length > 0) {
    throw new Error(
      `excalidraw-fonts-css: required families missing from output: ${missing.join(", ")}`,
    );
  }
}

/**
 * @param {readonly FontFaceSource[]} faces
 * @param {string} urlPrefix  字型檔的公開路徑前綴，例如 `/excalidraw-assets/fonts`
 * @returns {string}
 */
export function buildFontsCss(faces, urlPrefix) {
  const rules = faces.map(
    (face) =>
      `@font-face {\n` +
      `  font-family: "${face.family}";\n` +
      `  src: url("${urlPrefix}/${face.dir}/${face.file}") format("woff2");\n` +
      `  font-weight: ${face.weight};\n` +
      `  font-style: normal;\n` +
      // block：字型到達前不先以系統字型畫一次（viewer 另以 document.fonts.load()
      // 等文字用到的 face 到齊、或 3 秒 deadline 到期後才淡入）
      `  font-display: block;\n` +
      `  unicode-range: ${face.unicodeRange};\n` +
      `}\n`,
  );
  return (
    `/* Generated by scripts/sync-excalidraw-assets.mjs from @excalidraw/excalidraw fonts. Do not edit. */\n` +
    rules.join("")
  );
}
