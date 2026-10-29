// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LocalSceneSaveWarning } from "@/components/excalidraw/local-scene-save-warning";
import { setLocalSceneSaveFailed } from "@/data/local-scene-save-status";
import { saveToLocalStorage } from "@/lib/excalidraw";
import { importFromLocalStorage } from "@/data/local-storage";

vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ t: (key: string) => key }),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps the warning through failed writes and clears it after a successful write", () => {
  setLocalSceneSaveFailed(false);
  const container = document.createElement("div");
  const root = createRoot(container);
  const blocked = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    // Failure before mounting must also be visible.
    expect(saveToLocalStorage([], {}, {})).toBe(false);
    act(() => root.render(<LocalSceneSaveWarning />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "storage.localSaveFailed",
    );
    act(() => {
      expect(saveToLocalStorage([], {}, {})).toBe(false);
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    blocked.mockRestore();
    act(() => {
      expect(saveToLocalStorage([], {}, {})).toBe(true);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    setLocalSceneSaveFailed(false);
  }
});

it("returns empty local data when the storage getter itself is blocked", () => {
  const getter = vi
    .spyOn(window, "localStorage", "get")
    .mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
  try {
    expect(importFromLocalStorage()).toEqual({
      elements: [],
      appState: null,
      files: {},
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(saveToLocalStorage([], {}, {})).toBe(false);
  } finally {
    getter.mockRestore();
    setLocalSceneSaveFailed(false);
  }
});
