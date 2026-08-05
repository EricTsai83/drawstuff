import { webcrypto } from "node:crypto";
import { afterEach, vi } from "vitest";

/**
 * jsdom ships `crypto.getRandomValues` but no `crypto.subtle`, and collaboration
 * code legitimately depends on it (snapshot digests, sealing). Node's own Web
 * Crypto is the closest thing to a browser's, and the collaboration package
 * separately re-runs its crypto suite in real Chromium and WebKit, so this fills
 * the jsdom gap without becoming the only implementation under test.
 */
if (typeof globalThis.crypto?.subtle === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}

afterEach(() => {
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverStub,
});

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () =>
      ({
        filter: "none",
      }) as unknown as CanvasRenderingContext2D,
  });
}
