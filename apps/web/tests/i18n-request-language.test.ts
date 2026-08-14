import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server 端語言解析是 hydration 一致性的來源：`<html lang>` 與 provider 初始字典
 * 都由這裡決定，client 首次 render 不得再自行推導語言。
 */

// `import "server-only"` 在非 RSC 環境會直接 throw，測試裡以空 module 取代
vi.mock("server-only", () => ({}));

const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const headerGet = vi.fn<(name: string) => string | null>();

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: cookieGet }),
  headers: () => Promise.resolve({ get: headerGet }),
}));

const { resolveRequestI18n } = await import("@/lib/i18n/server");

beforeEach(() => {
  cookieGet.mockReset();
  headerGet.mockReset();
  cookieGet.mockReturnValue(undefined);
  headerGet.mockReturnValue(null);
});

describe("resolveRequestI18n", () => {
  it("以 lang cookie 為準並載入對應字典", async () => {
    cookieGet.mockImplementation((name) =>
      name === "lang" ? { value: "zh-TW" } : undefined,
    );

    const { language, dictionary } = await resolveRequestI18n();

    expect(language).toBe("zh-TW");
    expect(dictionary["app.export.cloud.title"]).toBe("上傳雲端");
    expect(headerGet).not.toHaveBeenCalled();
  });

  it("cookie 帶不支援的語言時回退 en，不再讀 Accept-Language", async () => {
    cookieGet.mockReturnValue({ value: "de" });

    const { language, dictionary } = await resolveRequestI18n();

    expect(language).toBe("en");
    expect(dictionary["app.export.cloud.title"]).toBe("Cloud Upload");
    expect(headerGet).not.toHaveBeenCalled();
  });

  it.each([
    ["zh-TW,zh;q=0.9,en;q=0.8", "zh-TW"],
    ["zh-Hant-TW,zh-Hant;q=0.9", "zh-TW"],
    ["en-US,en;q=0.9", "en"],
    // 只在 en 之後才出現的繁中不應該蓋掉更高優先的 en
    ["en;q=0.9,zh-TW;q=0.8", "en"],
    // 未支援語言（含簡體）一律回退 en
    ["de-DE,fr;q=0.7", "en"],
    ["zh-CN,zh;q=0.9", "en"],
    ["*", "en"],
    // q 值優先於出現順序
    ["en;q=0.2,zh-TW;q=1", "zh-TW"],
    ["zh-TW;q=0.3,en;q=0.9", "en"],
    // q=0 是明確拒絕
    ["zh-TW;q=0,en;q=1", "en"],
    ["en;q=0,zh-TW;q=0.5", "zh-TW"],
    // 明確拒絕全部支援語言時仍回退 en（沒有其他可選）
    ["en;q=0,zh-TW;q=0", "en"],
    // wildcard 授 q 給未明確列出的語言：en 被拒、* 可接受 → zh-TW
    ["en;q=0,*;q=1", "zh-TW"],
    ["zh-TW;q=0,*;q=1", "en"],
    // enb 是別的語言，不是英文；不得壓過明確的 zh-TW
    ["enb;q=1,zh-TW;q=0.9", "zh-TW"],
    // 帶 extension 的繁中 tag 仍要被辨識
    ["zh-TW-u-nu-hanidec", "zh-TW"],
  ])(
    "沒有 cookie 時依 Accept-Language %s 解析為 %s",
    async (header, expected) => {
      headerGet.mockReturnValue(header);

      const { language } = await resolveRequestI18n();

      expect(language).toBe(expected);
    },
  );

  it("完全沒有語言線索時使用 en", async () => {
    const { language } = await resolveRequestI18n();

    expect(language).toBe("en");
  });
});
