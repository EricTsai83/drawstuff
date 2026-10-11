// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppState,
  BinaryFiles,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import { saveData, saveToLocalStorage } from "@/lib/excalidraw";

const elements = [] as unknown as OrderedExcalidrawElement[];
const files = {} as BinaryFiles;

/** Real localStorage, except writes of new values to `failingKey` overflow. */
function failWritesTo(failingKey: string) {
  const store = new Map<string, string>();
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)!;
    store.set(key, localStorage.getItem(key)!);
  }
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
    if (key === failingKey && value !== store.get(key)) {
      throw new DOMException("full", "QuotaExceededError");
    }
    store.set(key, value);
  });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(
    (key) => store.get(key) ?? null,
  );
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
    store.delete(key);
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "old-elements");
  localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "old-files");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("saveToLocalStorage", () => {
  it("writes elements, app state and files together", () => {
    expect(saveToLocalStorage(elements, { name: "s" }, files)).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      "[]",
    );
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES)).toBe("{}");
  });

  it("puts every key back when a later write exceeds the quota", () => {
    failWritesTo(STORAGE_KEYS.LOCAL_STORAGE_FILES);

    expect(saveToLocalStorage(elements, { name: "s" }, files)).toBe(false);

    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      "old-elements",
    );
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE)).toBe(
      null,
    );
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES)).toBe(
      "old-files",
    );
  });

  it("restores within the original space when keys trade sizes", () => {
    // Total-capacity storage: new elements shrink, new app state grows, and
    // the files write then overflows. Restoring elements before app state
    // would itself overflow and leave a mixed scene.
    const store = new Map<string, string>([
      [STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "e".repeat(40)],
      [STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, "a"],
      [STORAGE_KEYS.LOCAL_STORAGE_FILES, "{}"],
    ]);
    const capacity = 50;
    const used = () =>
      [...store.values()].reduce((total, value) => total + value.length, 0);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(
      (key) => store.get(key) ?? null,
    );
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
      store.delete(key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      const next = used() - (store.get(key)?.length ?? 0) + value.length;
      if (next > capacity) throw new DOMException("full", "QuotaExceededError");
      store.set(key, value);
    });

    const bigAppState = { name: "n".repeat(30) };
    const bigFiles = { x: "f".repeat(30) } as unknown as BinaryFiles;
    expect(saveToLocalStorage(elements, bigAppState, bigFiles)).toBe(false);

    expect(store.get(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe("e".repeat(40));
    expect(store.get(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE)).toBe("a");
    expect(store.get(STORAGE_KEYS.LOCAL_STORAGE_FILES)).toBe("{}");
  });

  it("reports failure instead of throwing when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(saveToLocalStorage(elements, {}, files)).toBe(false);
  });

  it("does not bump the cross-tab version stamps after a failed save", () => {
    failWritesTo(STORAGE_KEYS.LOCAL_STORAGE_FILES);

    saveData({ elements, appState: {} as AppState, files });

    expect(localStorage.getItem(STORAGE_KEYS.VERSION_DATA_STATE)).toBeNull();
  });
});
