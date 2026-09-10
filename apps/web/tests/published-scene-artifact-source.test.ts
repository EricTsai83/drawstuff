// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createArtifactSceneSource } from "@/components/excalidraw/published-scene-artifact-source";
import { applyArtifactTheme } from "@/lib/svg-theme-variants";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" data-scene="s"><script>alert(1)</script><text>t</text></svg>`;

const urls = { url: "https://app.ufs.sh/f/artifact-key" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createArtifactSceneSource", () => {
  it("repairs legacy image filters before applying either theme", async () => {
    const rootFilter = "invert(93%) hue-rotate(180deg)";
    const imageFilter = "invert(100%) hue-rotate(180deg) saturate(1.25)";
    const variants = (filter: string) =>
      JSON.stringify({ light: { filter: null }, dark: { filter } });
    const legacy = `<svg xmlns="http://www.w3.org/2000/svg" data-theme-variants='${variants(rootFilter)}'><defs><image id="photo" href="data:image/png;base64,AA==" width="4" height="4"/></defs><use href="#photo" data-theme-variants='${variants(imageFilter)}'/></svg>`;
    const fetchMock = vi.fn(() => Promise.resolve(new Response(legacy)));
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    const svg = await source.load(new AbortController().signal);
    const use = svg.querySelector("use");
    const filter = svg.querySelector("defs > filter");

    expect(filter).not.toBeNull();
    expect(use?.hasAttribute("filter")).toBe(false);
    applyArtifactTheme(svg, "dark");
    expect(svg.getAttribute("filter")).toBe(rootFilter);
    expect(use?.getAttribute("filter")).toBe(
      `url(#${filter?.getAttribute("id")})`,
    );
    applyArtifactTheme(svg, "light");
    expect(use?.hasAttribute("filter")).toBe(false);
    applyArtifactTheme(svg, "dark");
    expect(use?.getAttribute("filter")).toBe(
      `url(#${filter?.getAttribute("id")})`,
    );
    expect(svg.querySelectorAll("defs > filter")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads the artifact once and sanitizes it", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(new Response(SVG, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    const first = await source.load(new AbortController().signal);

    expect(first.getAttribute("data-scene")).toBe("s");
    expect(first.querySelector("script")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([urls.url]);

    // Loading again reuses the downloaded text but yields a fresh element,
    // because the previous one is still mounted on the stage.
    const second = await source.load(new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second.getAttribute("data-scene")).toBe("s");
  });

  it("rejects a failed download and retries it on the next load", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(new Response(SVG, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    await expect(source.load(new AbortController().signal)).rejects.toThrow(
      /404/,
    );
    await expect(
      source.load(new AbortController().signal).then((svg) => svg.localName),
    ).resolves.toBe("svg");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hand a later load a request an earlier load aborted", async () => {
    // React Strict Mode: effect runs, cleanup aborts, effect runs again.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        setTimeout(() => resolve(new Response(SVG)), 5);
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    const first = new AbortController();
    const firstLoad = source.load(first.signal);
    first.abort();
    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });

    const second = await source.load(new AbortController().signal);
    expect(second.getAttribute("data-scene")).toBe("s");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("identifies the scene by its URL", () => {
    expect(createArtifactSceneSource(urls).key).toBe(
      createArtifactSceneSource({ ...urls }).key,
    );
    expect(createArtifactSceneSource(urls).key).not.toBe(
      createArtifactSceneSource({ url: "https://app.ufs.sh/f/x" }).key,
    );
  });
});
