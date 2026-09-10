import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  PublishedSceneViewer,
  type PublishedSceneSource,
} from "@/components/excalidraw/published-scene-viewer";
import { mergeThemeVariants } from "@/lib/svg-theme-variants";

const theme = vi.hoisted(() => ({
  resolvedTheme: undefined as string | undefined,
  setTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({ useTheme: () => theme }));
vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ t: (key: string) => key }),
}));

const SVG_NS = "http://www.w3.org/2000/svg";
const ROOT_FILTER = "invert(93%) hue-rotate(180deg)";

/** An artifact shaped like a real one: one file carrying both themes. */
function buildArtifact(): SVGSVGElement {
  const variant = (dark: boolean) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "100");
    svg.setAttribute("height", "100");
    if (dark) svg.setAttribute("filter", ROOT_FILTER);
    // The engine paints the scene background as the first direct rect; the
    // viewer reads it back to extend the same colour across the viewport.
    const background = document.createElementNS(SVG_NS, "rect");
    background.setAttribute("x", "0");
    background.setAttribute("y", "0");
    background.setAttribute("width", "100");
    background.setAttribute("height", "100");
    background.setAttribute("fill", "#ffffff");
    svg.appendChild(background);
    return svg;
  };
  return mergeThemeVariants(variant(false), variant(true));
}

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

it("starts the download without waiting for the theme to resolve", async () => {
  // One artifact serves both themes, so there is no wrong variant to show
  // early and no reason to hold the request until hydration settles.
  const load = vi.fn<PublishedSceneSource["load"]>(
    () =>
      new Promise(() => {
        // Keep the download pending.
      }),
  );

  await act(async () => {
    root.render(
      <PublishedSceneViewer
        source={{ key: "scene", load }}
        sceneName="Scene"
      />,
    );
  });

  expect(load).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  expect(container.textContent).toContain("public.viewer.loading");
});

it.each(["light", "dark"])(
  "hydrates with the browser's %s preference and requests once",
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
    expect(load).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
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
  let resolveLoad!: (svg: SVGSVGElement) => void;
  const load = vi.fn<PublishedSceneSource["load"]>(
    () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
  );
  const source = { key: "switching", load };
  const render = () =>
    act(async () => {
      root.render(<PublishedSceneViewer source={source} sceneName="Scene" />);
    });
  const svg = buildArtifact();
  theme.resolvedTheme = "light";
  await render();
  await act(async () => resolveLoad(svg));
  const stage = container.querySelector('[role="img"][aria-label="Scene"]')!;
  expect(stage.firstElementChild).toBe(svg);
  expect(container.textContent).not.toContain("public.viewer.loading");
  return { load, render, stage, svg };
}

it("switches theme on the mounted scene without another download", async () => {
  const { load, render, stage, svg } = await mountLoadedScene();
  expect(svg.hasAttribute("filter")).toBe(false);

  theme.resolvedTheme = "dark";
  await render();

  // Same element, same single request: the theme is a DOM write.
  expect(stage.firstElementChild).toBe(svg);
  expect(load).toHaveBeenCalledTimes(1);
  expect(svg.getAttribute("filter")).toBe(ROOT_FILTER);
  expect(stage.getAttribute("aria-busy")).toBe("false");

  theme.resolvedTheme = "light";
  await render();
  expect(load).toHaveBeenCalledTimes(1);
  expect(svg.hasAttribute("filter")).toBe(false);
});

it("paints the viewport backdrop through the active theme's filter", async () => {
  const { render, svg } = await mountLoadedScene();
  const backdrop = () =>
    [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(
      (element) => element.style.backgroundColor !== "",
    );

  // The backdrop mirrors the artifact's root filter, which is itself themed.
  expect(svg.hasAttribute("filter")).toBe(false);

  expect(backdrop()?.style.filter).toBe("");

  theme.resolvedTheme = "dark";
  await render();
  expect(backdrop()?.style.filter).toBe(ROOT_FILTER);
});
