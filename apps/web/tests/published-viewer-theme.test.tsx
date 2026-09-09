import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  PublishedSceneViewer,
  type PublishedSceneSource,
} from "@/components/excalidraw/published-scene-viewer";

const theme = vi.hoisted(() => ({
  resolvedTheme: undefined as string | undefined,
  setTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({ useTheme: () => theme }));
vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ t: (key: string) => key }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  theme.resolvedTheme = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it.each(["light", "dark"])(
  "waits for the resolved %s theme before requesting an artifact",
  async (resolvedTheme) => {
    const load = vi.fn<PublishedSceneSource["load"]>(
      () =>
        new Promise(() => {
          // Keep the download pending to test theme resolution and cancellation.
        }),
    );
    const source = { key: "scene", load };
    const render = () =>
      act(async () => {
        root.render(<PublishedSceneViewer source={source} sceneName="Scene" />);
      });

    await render();
    expect(load).not.toHaveBeenCalled();
    expect(container.textContent).toContain("public.viewer.loading");

    theme.resolvedTheme = resolvedTheme;
    await render();
    expect(load).toHaveBeenCalledExactlyOnceWith(
      resolvedTheme,
      expect.any(AbortSignal),
    );

    const signal = load.mock.calls[0]![1];
    theme.resolvedTheme = resolvedTheme === "dark" ? "light" : "dark";
    await render();
    expect(signal.aborted).toBe(true);
    expect(load).toHaveBeenLastCalledWith(
      theme.resolvedTheme,
      expect.any(AbortSignal),
    );
  },
);

it.each(["light", "dark"])(
  "hydrates with the browser's %s preference without loading the server fallback",
  async (resolvedTheme) => {
    await act(async () => root.unmount());
    const load = vi.fn<PublishedSceneSource["load"]>(
      () =>
        new Promise(() => {
          // Keep the artifact pending while hydration settles.
        }),
    );
    const app = (
      <PublishedSceneViewer
        source={{ key: "hydration", load }}
        sceneName="Scene"
      />
    );
    container.innerHTML = renderToString(app);
    theme.resolvedTheme = resolvedTheme;
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, "error");

    await act(async () => {
      root = hydrateRoot(container, app, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledExactlyOnceWith(
      resolvedTheme,
      expect.any(AbortSignal),
    );
    expect(
      container.querySelector(
        `.lucide-${resolvedTheme === "dark" ? "moon" : "sun"}`,
      ),
    ).not.toBeNull();
  },
);
