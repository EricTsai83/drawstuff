import { describe, expect, it } from "vitest";

import { meaningfulSceneName } from "@/lib/scene-name";

describe("meaningfulSceneName", () => {
  it("drops Excalidraw's timestamped default name in any language", () => {
    expect(meaningfulSceneName("Untitled-2026-10-11-0130")).toBe("");
    expect(meaningfulSceneName("無標題-2026-10-11-0130")).toBe("");
  });

  it("keeps a name the user chose", () => {
    expect(meaningfulSceneName(" Roadmap ")).toBe("Roadmap");
    expect(meaningfulSceneName("Sprint 2026-10")).toBe("Sprint 2026-10");
    expect(meaningfulSceneName(undefined)).toBe("");
  });
});
