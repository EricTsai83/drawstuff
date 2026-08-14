import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { I18nProvider } from "@/hooks/i18n-context";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { dispatchLanguageChange } from "@/lib/events";
import { en } from "@/lib/i18n/en";

// 先載入 zh-TW 字典，讓 provider 的 dynamic import 直接命中 module cache，
// 測試就不必為冷啟動的 transform 時間留額外的 flush。
await import("@/lib/i18n/zh-tw");

/**
 * Provider 的合約：client 首次 render 必須完全沿用 server 下發的語言與字典
 * （否則 zh-TW 使用者每次載入都會 hydration mismatch），語言切換才允許
 * 之後 dynamic import 另一份字典並寫回 cookie。
 */

const actEnvironment = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function Probe() {
  const { t, langCode } = useAppI18n();
  return <span data-lang={langCode}>{t("app.export.cloud.title")}</span>;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 讓 dynamic import 的字典與後續 state 更新落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 在 act 內反覆 flush，直到語言切換落地或超出重試次數。 */
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await flush();
  }
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  document.cookie = "lang=; path=/; max-age=0";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("I18nProvider", () => {
  it("首次 render 使用 server 的語言，localStorage 偏好只在之後才生效", async () => {
    // 舊使用者的偏好仍在 localStorage，但 server 這次還是渲染 en
    localStorage.setItem("i18nextLng", "zh-TW");

    act(() =>
      root.render(
        <I18nProvider initialLanguage="en" initialDictionary={en}>
          <Probe />
        </I18nProvider>,
      ),
    );

    // 與 server HTML 相同的字串，因此不會產生 text mismatch
    expect(container.textContent).toBe("Cloud Upload");

    await flushUntil(() => container.textContent === "上傳雲端");

    expect(container.textContent).toBe("上傳雲端");
    expect(container.querySelector("span")?.dataset.lang).toBe("zh-TW");
    // 下次載入 server 就能直接渲染 zh-TW
    expect(document.cookie).toContain("lang=zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("語言切換事件會換掉字典並更新 cookie", async () => {
    localStorage.setItem("i18nextLng", "en");

    act(() =>
      root.render(
        <I18nProvider initialLanguage="en" initialDictionary={en}>
          <Probe />
        </I18nProvider>,
      ),
    );
    await flush();
    expect(container.textContent).toBe("Cloud Upload");
    expect(document.cookie).toContain("lang=en");

    act(() => dispatchLanguageChange({ langCode: "zh-TW" }));
    await flushUntil(() => container.textContent === "上傳雲端");

    expect(container.textContent).toBe("上傳雲端");
    expect(document.cookie).toContain("lang=zh-TW");
  });

  it("切出去又切回來時，未完成的字典載入不得覆蓋最後選定的語言", async () => {
    localStorage.setItem("i18nextLng", "en");

    act(() =>
      root.render(
        <I18nProvider initialLanguage="en" initialDictionary={en}>
          <Probe />
        </I18nProvider>,
      ),
    );
    await flush();

    // 兩次切換都在第一次 dynamic import 落地前發生
    act(() => {
      dispatchLanguageChange({ langCode: "zh-TW" });
      dispatchLanguageChange({ langCode: "en" });
    });
    await flush();
    await flush();

    expect(container.textContent).toBe("Cloud Upload");
    expect(container.querySelector("span")?.dataset.lang).toBe("en");
    expect(document.cookie).toContain("lang=en");
  });

  it("不支援的語言碼回退 en 字典", async () => {
    localStorage.setItem("i18nextLng", "de");

    act(() =>
      root.render(
        <I18nProvider initialLanguage="en" initialDictionary={en}>
          <Probe />
        </I18nProvider>,
      ),
    );
    await flush();

    expect(container.textContent).toBe("Cloud Upload");
    expect(container.querySelector("span")?.dataset.lang).toBe("en");
  });
});
