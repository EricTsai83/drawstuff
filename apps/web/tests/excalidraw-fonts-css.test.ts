import { EXCALIDRAW_FONT_FAMILY } from "@drawstuff/excalidraw-adapter/client";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCanvasFontFaces,
  buildFontsCss,
  CANVAS_FONT_FAMILY_BY_DIR,
  formatUnicodeRange,
  readCanvasFontFaces,
  resolveExcalidrawPackage,
} from "../scripts/excalidraw-fonts-css.mjs";

// 直接對 lockfile 解析出的套件字型目錄跑產生器；產物與 sync 到 public/ 的完全
// 相同（sync 只是複製），且不依賴 dev/build 是否已執行過。
const faces = readCanvasFontFaces(resolveExcalidrawPackage().fontsDir);

describe("formatUnicodeRange", () => {
  it("merges consecutive code points into CSS ranges", () => {
    expect(formatUnicodeRange([0x20, 0x21, 0x22, 0x41, 0x4e2d, 0x4e2e])).toBe(
      "U+0020-0022, U+0041, U+4E2D-4E2E",
    );
  });

  it("sorts and de-duplicates unordered input", () => {
    expect(formatUnicodeRange([0x43, 0x41, 0x42, 0x41])).toBe("U+0041-0043");
  });

  it("returns an empty string for an empty cmap", () => {
    expect(formatUnicodeRange([])).toBe("");
  });
});

describe("CANVAS_FONT_FAMILY_BY_DIR", () => {
  it("covers exactly the upstream FONT_FAMILY keys plus the Xiaolai fallback", () => {
    // 匯出 SVG 的 font-family 用的是 FONT_FAMILY key（加 CJK fallback 家族），
    // 不是 woff2 name table；上游新增／改名家族時這裡先失敗。Helvetica 是
    // local()，沒有檔案。
    const upstream = Object.keys(EXCALIDRAW_FONT_FAMILY).filter(
      (family) => family !== "Helvetica",
    );
    expect(new Set(Object.values(CANVAS_FONT_FAMILY_BY_DIR))).toEqual(
      new Set([...upstream, "Xiaolai"]),
    );
  });
});

describe("readCanvasFontFaces", () => {
  it("reads one face per shipped woff2 with the upstream family name", () => {
    const byFamily = new Map<string, typeof faces>();
    for (const face of faces) {
      byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
    }

    // 209 個 Xiaolai 子集、7 個 Excalifont 子集（0.18.1 出貨數量）。
    expect(byFamily.get("Xiaolai")).toHaveLength(209);
    expect(byFamily.get("Excalifont")).toHaveLength(7);
    expect(byFamily.get("Virgil")).toHaveLength(1);
    // name table 與家族名不同的四個家族仍以 FONT_FAMILY key 出現。
    for (const family of [
      "Cascadia",
      "Comic Shanns",
      "Nunito",
      "Xiaolai",
      "Lilita One",
      "Liberation Sans",
    ]) {
      expect(byFamily.has(family), family).toBe(true);
    }
    expect(byFamily.has("Helvetica")).toBe(false);
    // Assistant 是編輯器 UI 字型，由上游 index.css 載入，不進畫布 CSS。
    expect(byFamily.has("Assistant")).toBe(false);
  });

  it("derives unicode-range from the cmap and weight from OS/2", () => {
    for (const face of faces) {
      expect(face.unicodeRange, `${face.dir}/${face.file}`).toMatch(
        /^U\+[0-9A-F]{4,}(-[0-9A-F]{4,})?(, U\+[0-9A-F]{4,}(-[0-9A-F]{4,})?)*$/,
      );
    }
    // 上游對 Nunito 註冊 weight 500，其餘 400；直接從檔案讀出即一致。
    const weights = new Set(
      faces
        .filter((face) => face.family === "Nunito")
        .map((face) => face.weight),
    );
    expect(weights).toEqual(new Set([500]));
    expect(
      faces
        .filter((face) => face.family !== "Nunito")
        .every((face) => face.weight === 400),
    ).toBe(true);

    const cjk = faces.find(
      (face) =>
        face.family === "Xiaolai" && face.unicodeRange.includes("U+4E2D"),
    );
    // 「中」（U+4E2D）必須落在某個 Xiaolai 子集裡。
    expect(cjk).toBeDefined();
  });

  it("gives every code point of a family to exactly one face", () => {
    // 同家族子集的 cmap 互相重疊（Nunito 五個子集都含 U+0041）；@font-face 對同一
    // codepoint 後宣告者勝，不去重會讓純拉丁文字抓到字母序最後的檔案。
    const seen = new Map<string, Set<number>>();
    for (const face of faces) {
      const claimed = seen.get(face.family) ?? new Set<number>();
      for (const part of face.unicodeRange.split(", ")) {
        const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/.exec(part);
        expect(match, `${face.dir}/${face.file}: ${part}`).not.toBeNull();
        const start = Number.parseInt(match![1]!, 16);
        const end = match![2] ? Number.parseInt(match![2], 16) : start;
        for (let cp = start; cp <= end; cp++) {
          expect(claimed.has(cp), `${face.family} U+${cp.toString(16)}`).toBe(
            false,
          );
          claimed.add(cp);
        }
      }
      seen.set(face.family, claimed);
    }
    // 去重後沒有子集被完全涵蓋而消失：輸出 face 數等於畫布字型檔數。
    expect(faces.filter((face) => face.family === "Nunito")).toHaveLength(5);
    const fontsDir = resolveExcalidrawPackage().fontsDir;
    const shippedCanvasFiles = readdirSync(fontsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "Assistant")
      .flatMap((entry) =>
        readdirSync(path.join(fontsDir, entry.name)).filter((file) =>
          file.endsWith(".woff2"),
        ),
      );
    expect(faces).toHaveLength(shippedCanvasFiles.length);
  });

  it("passes the structural checks on the shipped font set", () => {
    expect(() => assertCanvasFontFaces(faces)).not.toThrow();
  });

  describe("directory guards (upstream adds or drops a family)", () => {
    const tempDirs: string[] = [];
    afterEach(() => {
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
    });

    function copyOfShippedFonts(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-fonts-"));
      tempDirs.push(dir);
      cpSync(resolveExcalidrawPackage().fontsDir, dir, { recursive: true });
      return dir;
    }

    it("throws on a directory that is neither a canvas family nor a known UI font", () => {
      const dir = copyOfShippedFonts();
      mkdirSync(path.join(dir, "Bogus"));
      expect(() => readCanvasFontFaces(dir)).toThrow(
        /unmapped font directory "Bogus"/,
      );
    });

    it("throws when one family directory ships more than one weight", () => {
      // 認領以家族為單位；多字重需先改成 per-weight 認領，不能靜默扣光另一字重。
      const dir = copyOfShippedFonts();
      renameSync(
        path.join(dir, "Assistant", "Assistant-Bold.woff2"),
        path.join(dir, "Virgil", "Virgil-Bold.woff2"),
      );
      expect(() => readCanvasFontFaces(dir)).toThrow(/multiple weights/);
    });

    it("throws when a mapped canvas family directory is missing", () => {
      const dir = copyOfShippedFonts();
      rmSync(path.join(dir, "Xiaolai"), { recursive: true });
      expect(() => readCanvasFontFaces(dir)).toThrow(/"Xiaolai" is missing/);
    });
  });
});

describe("assertCanvasFontFaces", () => {
  it("rejects an empty unicode-range (silent fontkit parse failure)", () => {
    const broken = faces.map((face, index) =>
      index === 0 ? { ...face, unicodeRange: "" } : face,
    );
    expect(() => assertCanvasFontFaces(broken)).toThrow(/empty unicode-range/);
  });

  it("rejects an output missing a required family", () => {
    expect(() =>
      assertCanvasFontFaces(faces.filter((face) => face.family !== "Xiaolai")),
    ).toThrow(/Xiaolai/);
  });
});

describe("buildFontsCss", () => {
  it("emits one @font-face per face pointing at the self-hosted URL", () => {
    const css = buildFontsCss(
      [
        {
          family: "Comic Shanns",
          dir: "ComicShanns",
          file: "ComicShanns-Regular-abc.woff2",
          weight: 400,
          unicodeRange: "U+0020-007E",
        },
      ],
      "/excalidraw-assets/fonts",
    );

    expect(css).toContain('font-family: "Comic Shanns";');
    expect(css).toContain(
      'src: url("/excalidraw-assets/fonts/ComicShanns/ComicShanns-Regular-abc.woff2") format("woff2");',
    );
    expect(css).toContain("font-display: block;");
    expect(css).toContain("unicode-range: U+0020-007E;");
    // 沒有內嵌字型，也沒有任何外部 host：整份 CSS 都落在 font-src 'self'。
    expect(css).not.toContain("data:");
    expect(css).not.toContain("esm.sh");
  });

  it("produces one rule per shipped face and no Helvetica", () => {
    const css = buildFontsCss(faces, "/excalidraw-assets/fonts");
    expect(css.match(/@font-face/g)).toHaveLength(faces.length);
    expect(css).not.toContain("Helvetica");
  });
});
