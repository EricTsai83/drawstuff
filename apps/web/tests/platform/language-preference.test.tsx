// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const dispatchLanguageChange = vi.hoisted(() => vi.fn());
vi.mock("@/lib/events", () => ({ dispatchLanguageChange }));

const { useLanguagePreference } =
  await import("@/hooks/use-language-preference");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("useLanguagePreference", () => {
  it("still switches and announces the language when storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);

    let hook: ReturnType<typeof useLanguagePreference> | undefined;
    function Probe() {
      const value = useLanguagePreference();
      useEffect(() => {
        hook = value;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));

    act(() => hook?.handleLangCodeChange("zh-TW"));

    expect(hook?.langCode).toBe("zh-TW");
    expect(dispatchLanguageChange).toHaveBeenCalledWith({ langCode: "zh-TW" });
    act(() => root.unmount());
  });
});
