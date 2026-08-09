// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  fetchOfficialExcalidrawLibrary,
  isOfficialExcalidrawLibraryUrl,
  MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES,
} from "../src/client";

const responseAt = (url: string, body: BodyInit, init?: ResponseInit) => {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
};

describe("official Excalidraw Library URL safety", () => {
  it("accepts only the exact HTTPS catalog origin", () => {
    expect(
      isOfficialExcalidrawLibraryUrl(
        "https://libraries.excalidraw.com/libraries/example.excalidrawlib",
      ),
    ).toBe(true);
    for (const url of [
      "http://libraries.excalidraw.com/library.excalidrawlib",
      "https://libraries.excalidraw.com.evil.test/library.excalidrawlib",
      "https://evil.test@libraries.excalidraw.com/library.excalidrawlib",
      "https://libraries.excalidraw.com:444/library.excalidrawlib",
    ]) {
      expect(isOfficialExcalidrawLibraryUrl(url)).toBe(false);
    }
  });

  it("downloads an allowed response without credentials or referrer", async () => {
    const url =
      "https://libraries.excalidraw.com/libraries/example.excalidrawlib";
    const fetchLibrary = vi.fn(async () =>
      responseAt(url, "library", {
        headers: { "content-type": "application/octet-stream" },
      }),
    );

    const blob = await fetchOfficialExcalidrawLibrary(url, fetchLibrary);
    expect(await blob.text()).toBe("library");
    expect(fetchLibrary).toHaveBeenCalledWith(url, {
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
  });

  it("rejects a redirect outside the official origin", async () => {
    const url =
      "https://libraries.excalidraw.com/libraries/example.excalidrawlib";
    await expect(
      fetchOfficialExcalidrawLibrary(url, async () =>
        responseAt("https://evil.test/library.excalidrawlib", "library"),
      ),
    ).rejects.toThrow("redirected to a disallowed origin");
  });

  it("rejects declared and streamed responses over the byte bound", async () => {
    const url =
      "https://libraries.excalidraw.com/libraries/example.excalidrawlib";
    await expect(
      fetchOfficialExcalidrawLibrary(url, async () =>
        responseAt(url, "", {
          headers: {
            "content-length": String(MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES + 1),
          },
        }),
      ),
    ).rejects.toThrow("too large");

    await expect(
      fetchOfficialExcalidrawLibrary(url, async () =>
        responseAt(
          url,
          new Uint8Array(MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES + 1),
        ),
      ),
    ).rejects.toThrow("too large");
  });

  it("surfaces fetch failures", async () => {
    await expect(
      fetchOfficialExcalidrawLibrary(
        "https://libraries.excalidraw.com/libraries/example.excalidrawlib",
        async () => {
          throw new Error("offline");
        },
      ),
    ).rejects.toThrow("offline");
  });
});
