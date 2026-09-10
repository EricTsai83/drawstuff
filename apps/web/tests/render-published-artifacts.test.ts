import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

const mocks = vi.hoisted(() => ({
  exportSceneToSvg: vi.fn(),
}));

vi.mock("@drawstuff/excalidraw-adapter/client", () => ({
  exportSceneToSvg: mocks.exportSceneToSvg,
}));

import { EXCALIDRAW_ENGINE_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import {
  ARTIFACT_IMAGE_QUALITY,
  optimizeArtifactFiles,
  renderPublishedArtifacts,
  type ArtifactImageEncoder,
} from "@/lib/render-published-artifacts";
import type { BinaryFiles } from "@drawstuff/excalidraw-adapter/types";

const SVG_NS = "http://www.w3.org/2000/svg";

function fakeExport(options: { appState: { exportWithDarkMode?: boolean } }) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute(
    "data-theme",
    options.appState.exportWithDarkMode ? "dark" : "light",
  );
  const anchor = document.createElementNS(SVG_NS, "a");
  anchor.setAttribute("href", "https://example.com");
  svg.appendChild(anchor);
  return Promise.resolve(svg);
}

const element = (id: string, isDeleted = false) =>
  ({ id, type: "rectangle", isDeleted }) as unknown as ExcalidrawElement;

beforeEach(() => {
  mocks.exportSceneToSvg.mockReset();
  mocks.exportSceneToSvg.mockImplementation(fakeExport);
});

describe("renderPublishedArtifacts", () => {
  it("exports a light and a dark variant with the viewer's fidelity settings", async () => {
    const appState = {
      viewBackgroundColor: "#123456",
      exportEmbedScene: true,
      exportScale: 2,
      name: "scene",
    };
    const files = {};

    const rendered = await renderPublishedArtifacts({
      elements: [element("a"), element("gone", true)],
      appState,
      files,
    });

    expect(mocks.exportSceneToSvg).toHaveBeenCalledTimes(2);
    const calls = mocks.exportSceneToSvg.mock.calls.map(
      ([options]) =>
        options as {
          elements: ExcalidrawElement[];
          appState: Record<string, unknown>;
          files: unknown;
          skipInliningFonts?: boolean;
        },
    );
    for (const call of calls) {
      // Tombstones never reach the engine.
      expect(call.elements.map((item) => item.id)).toEqual(["a"]);
      // No raster images: the optimised map equals the input.
      expect(call.files).toEqual(files);
      expect(call.skipInliningFonts).toBe(true);
      expect(call.appState).toMatchObject({
        viewBackgroundColor: "#123456",
        exportBackground: true,
        // The author's export-dialog settings do not leak into the artifact.
        exportEmbedScene: false,
        exportScale: 1,
      });
    }
    expect(
      calls.map((call) => call.appState.exportWithDarkMode).sort(),
    ).toEqual([false, true]);

    expect(rendered.engineVersion).toBe(EXCALIDRAW_ENGINE_VERSION);
    expect(rendered.artifact.type).toBe("image/svg+xml");
    const artifact = await rendered.artifact.text();
    // One file: the light render is the artifact and the dark render's
    // difference rides along as an override the viewer applies.
    expect(artifact).toContain('data-theme="light"');
    expect(artifact).not.toContain('data-theme="dark"');
    expect(artifact).toContain("data-theme-variants");
    expect(artifact).toContain(
      "&quot;dark&quot;:{&quot;data-theme&quot;:&quot;dark&quot;}",
    );
    // Links are hardened at render time; the viewer no longer post-processes.
    expect(artifact).toContain('target="_blank"');
    expect(artifact).toContain('rel="noopener noreferrer"');
  });

  it("propagates an export failure instead of returning a partial artifact", async () => {
    mocks.exportSceneToSvg.mockRejectedValueOnce(new Error("no canvas"));
    await expect(
      renderPublishedArtifacts({ elements: [], appState: {}, files: {} }),
    ).rejects.toThrow("no canvas");
  });
});

const file = (id: string, mimeType: string, dataURL: string) =>
  ({
    id,
    mimeType,
    dataURL,
    created: 1,
    lastRetrieved: 1,
  }) as unknown as BinaryFiles[string];

describe("optimizeArtifactFiles", () => {
  const png = "data:image/png;base64," + "A".repeat(400);
  const jpeg = "data:image/jpeg;base64," + "B".repeat(400);
  const svg = "data:image/svg+xml;base64," + "C".repeat(400);
  const gif = "data:image/gif;base64," + "D".repeat(400);
  const webp = "data:image/webp;base64," + "E".repeat(100);

  it("replaces raster images with a smaller WebP encoding and leaves the rest alone", async () => {
    const encode: ArtifactImageEncoder = vi.fn((dataURL: string) =>
      Promise.resolve(dataURL.startsWith("data:image/png") ? webp : null),
    );
    const files: BinaryFiles = {
      p: file("p", "image/png", png),
      j: file("j", "image/jpeg", jpeg),
      s: file("s", "image/svg+xml", svg),
      g: file("g", "image/gif", gif),
    };

    const optimized = await optimizeArtifactFiles(files, encode);

    expect(optimized.p).toMatchObject({
      mimeType: "image/webp",
      dataURL: webp,
    });
    // Encoder returned null (no WebP support): original kept.
    expect(optimized.j).toBe(files.j);
    // SVG and GIF are never re-encoded.
    expect(optimized.s).toBe(files.s);
    expect(optimized.g).toBe(files.g);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode).toHaveBeenCalledWith(png, ARTIFACT_IMAGE_QUALITY);
    expect(encode).toHaveBeenCalledWith(jpeg, ARTIFACT_IMAGE_QUALITY);
    // The editor's own files are not mutated.
    expect(files.p?.mimeType).toBe("image/png");
  });

  it("keeps the original when WebP is not smaller or the encoder fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bigger = "data:image/webp;base64," + "E".repeat(1000);
    const encode: ArtifactImageEncoder = vi
      .fn()
      .mockResolvedValueOnce(bigger)
      .mockRejectedValueOnce(new Error("no canvas"));
    const files: BinaryFiles = {
      a: file("a", "image/png", png),
      b: file("b", "image/jpeg", jpeg),
    };

    const optimized = await optimizeArtifactFiles(files, encode);

    expect(optimized.a).toBe(files.a);
    expect(optimized.b).toBe(files.b);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("feeds the optimised files to both exports", async () => {
    const encode: ArtifactImageEncoder = () => Promise.resolve(webp);
    await renderPublishedArtifacts(
      {
        elements: [],
        appState: {},
        files: { p: file("p", "image/png", png) },
      },
      { encodeImage: encode },
    );
    for (const [options] of mocks.exportSceneToSvg.mock.calls) {
      const { files } = options as { files: BinaryFiles };
      expect(files.p?.dataURL).toBe(webp);
    }
  });
});
