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

async function mountLoadedScene() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  const requests: {
    signal: AbortSignal;
    resolve: (svg: SVGSVGElement) => void;
    reject: (error: Error) => void;
  }[] = [];
  const load = vi.fn<PublishedSceneSource["load"]>(
    (_theme, signal) =>
      new Promise((resolve, reject) => {
        requests.push({ signal, resolve, reject });
      }),
  );
  const source = { key: "switching", load };
  const render = () =>
    act(async () => {
      root.render(<PublishedSceneViewer source={source} sceneName="Scene" />);
    });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100");
  svg.setAttribute("height", "100");
  theme.resolvedTheme = "light";
  await render();
  await act(async () => requests[0]!.resolve(svg));
  const stage = container.querySelector('[role="img"][aria-label="Scene"]')!;
  expect(stage.firstElementChild).toBe(svg);
  expect(container.textContent).not.toContain("public.viewer.loading");
  // No request for the other theme before the user switches.
  expect(load).toHaveBeenCalledTimes(1);
  return { requests, render, stage, svg };
}

it.each(["success", "failure"])(
  "keeps the scene visible with a loading status until theme switching ends in %s",
  async (outcome) => {
    const { requests, render, stage, svg } = await mountLoadedScene();
    theme.resolvedTheme = "dark";
    await render();
    expect(stage.firstElementChild).toBe(svg);
    expect(stage.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("public.viewer.switchingTheme");
    const nextSvg = svg.cloneNode(true) as SVGSVGElement;
    nextSvg.setAttribute("filter", "invert(93%) hue-rotate(180deg)");
    vi.spyOn(console, "error").mockImplementation(() => {
      // The failure case deliberately exercises the download error UI.
    });
    await act(async () => {
      if (outcome === "success") requests[1]!.resolve(nextSvg);
      else requests[1]!.reject(new Error("Download failed"));
    });
    expect(container.textContent).not.toContain("public.viewer.switchingTheme");
    expect(stage.getAttribute("aria-busy")).toBe("false");
    if (outcome === "success") expect(stage.firstElementChild).toBe(nextSvg);
    else expect(container.textContent).toContain("public.viewer.loadError");
  },
);

it("does not let a cancelled theme request clear the current loading status", async () => {
  const { requests, render, stage, svg } = await mountLoadedScene();
  theme.resolvedTheme = "dark";
  await render();
  theme.resolvedTheme = "light";
  await render();
  expect(requests[1]!.signal.aborted).toBe(true);
  await act(async () =>
    requests[1]!.resolve(svg.cloneNode(true) as SVGSVGElement),
  );
  expect(container.textContent).toContain("public.viewer.switchingTheme");
  expect(stage.getAttribute("aria-busy")).toBe("true");
  await act(async () =>
    requests[2]!.resolve(svg.cloneNode(true) as SVGSVGElement),
  );
  expect(container.textContent).not.toContain("public.viewer.switchingTheme");
  expect(stage.getAttribute("aria-busy")).toBe("false");
});
