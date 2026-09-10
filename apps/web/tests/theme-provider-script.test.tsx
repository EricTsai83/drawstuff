import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ThemeProvider, useTheme } from "next-themes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PublishedSceneViewer,
  type PublishedSceneSource,
} from "@/components/excalidraw/published-scene-viewer";

vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ t: (key: string) => key }),
}));

let container: HTMLDivElement;
let root: Root | undefined;
let media: EventTarget & { matches: boolean };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return media.matches;
    },
    addListener: (listener: EventListener) =>
      media.addEventListener("change", listener),
    removeListener: (listener: EventListener) =>
      media.removeEventListener("change", listener),
  }));
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.colorScheme = "";
});

function Toggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <>
      <output>{`${theme ?? "pending"}/${resolvedTheme ?? "pending"}`}</output>
      <button onClick={() => setTheme("light")}>Light</button>
    </>
  );
}

const createApp = () => (
  <ThemeProvider
    attribute="class"
    defaultTheme="system"
    enableSystem
    storageKey="theme"
  >
    <Toggle />
  </ThemeProvider>
);

it("preserves the server bootstrap for first-paint theme initialization", () => {
  const html = renderToString(createApp());
  expect(html).toContain("<script");
  expect(html).toContain("localStorage");
});

it.each(["light", "dark"])(
  "hydrates and preserves the existing %s preference",
  async (preference) => {
    localStorage.setItem("theme", preference);
    const app = createApp();
    container.innerHTML = renderToString(app);
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, "error");
    await act(async () => {
      root = hydrateRoot(container, app, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains(preference)).toBe(true);
    expect(container.querySelector("output")?.textContent).toBe(
      `${preference}/${preference}`,
    );
  },
);

it("hydrates the existing bootstrap and persists theme changes", async () => {
  const error = vi.spyOn(console, "error");
  const app = createApp();
  container.innerHTML = renderToString(app);
  await act(async () => {
    root = hydrateRoot(container, app);
  });
  expect(container.querySelectorAll("script")).toHaveLength(1);
  expect(error).not.toHaveBeenCalled();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await act(async () => container.querySelector("button")!.click());
  expect(document.documentElement.classList.contains("light")).toBe(true);
  expect(localStorage.getItem("theme")).toBe("light");
});

it.each(["light", "dark"])(
  "hydrates the public viewer under a saved %s preference",
  async (preference) => {
    localStorage.setItem("theme", preference);
    const load = vi.fn<PublishedSceneSource["load"]>(
      () =>
        new Promise(() => {
          // Keep the SVG download pending while the real provider hydrates.
        }),
    );
    const app = (
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey="theme"
      >
        <PublishedSceneViewer
          source={{ key: "scene", load }}
          sceneName="Scene"
        />
      </ThemeProvider>
    );
    container.innerHTML = renderToString(app);
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, "error");
    await act(async () => {
      root = hydrateRoot(container, app, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    // One artifact serves both themes, so the saved preference no longer
    // decides what is downloaded, only how it is painted.
    expect(load).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(document.documentElement.classList.contains(preference)).toBe(true);
  },
);

it("follows system changes and synchronizes preferences from another tab", async () => {
  const app = createApp();
  container.innerHTML = renderToString(app);
  await act(async () => {
    root = hydrateRoot(container, app);
  });
  await act(async () => {
    media.matches = false;
    media.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
  });
  expect(document.documentElement.classList.contains("light")).toBe(true);
  await act(async () => {
    localStorage.setItem("theme", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "theme",
        newValue: "dark",
        storageArea: localStorage,
      }),
    );
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("still applies the system theme when storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  const app = createApp();
  container.innerHTML = renderToString(app);
  await act(async () => {
    root = hydrateRoot(container, app);
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
