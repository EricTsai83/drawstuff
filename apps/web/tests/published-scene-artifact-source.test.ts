import { afterEach, describe, expect, it, vi } from "vitest";

import { createArtifactSceneSource } from "@/components/excalidraw/published-scene-artifact-source";

const SVG = (theme: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" data-theme="${theme}"><script>alert(1)</script><text>t</text></svg>`;

const urls = {
  lightUrl: "https://app.ufs.sh/f/light-key",
  darkUrl: "https://app.ufs.sh/f/dark-key",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createArtifactSceneSource", () => {
  it("fetches the variant for the requested theme and sanitizes it", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(SVG(url.endsWith("dark-key") ? "dark" : "light"), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    const light = await source.load("light", new AbortController().signal);
    const dark = await source.load("dark", new AbortController().signal);

    expect(light.getAttribute("data-theme")).toBe("light");
    expect(dark.getAttribute("data-theme")).toBe("dark");
    expect(light.querySelector("script")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      urls.lightUrl,
      urls.darkUrl,
    ]);

    // Toggling back reuses the downloaded text but yields a fresh element.
    const lightAgain = await source.load("light", new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lightAgain).not.toBe(light);
    expect(lightAgain.getAttribute("data-theme")).toBe("light");
  });

  it("rejects a failed download and retries it on the next load", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(new Response(SVG("light"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    await expect(
      source.load("light", new AbortController().signal),
    ).rejects.toThrow(/404/);
    await expect(
      source
        .load("light", new AbortController().signal)
        .then((svg) => svg.localName),
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
        setTimeout(() => resolve(new Response(SVG("light"))), 5);
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = createArtifactSceneSource(urls);
    const first = new AbortController();
    const firstLoad = source.load("light", first.signal);
    first.abort();
    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });

    const second = await source.load("light", new AbortController().signal);
    expect(second.getAttribute("data-theme")).toBe("light");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("identifies the scene by both URLs", () => {
    expect(createArtifactSceneSource(urls).key).toBe(
      createArtifactSceneSource({ ...urls }).key,
    );
    expect(createArtifactSceneSource(urls).key).not.toBe(
      createArtifactSceneSource({ ...urls, darkUrl: "https://app.ufs.sh/f/x" })
        .key,
    );
  });
});
