import { webcrypto } from "node:crypto";
import { afterEach, vi } from "vitest";

import { trackPendingCrypto } from "./support/async-drain";

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

/**
 * Counts the Web Crypto calls in flight, which is what lets the collaboration
 * tests wait for a digest instead of guessing how many event-loop turns one
 * takes. See `tests/support/async-drain.ts`.
 */
trackPendingCrypto();

afterEach(() => {
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // noop
  }
  unobserve(): void {
    // noop
  }
  disconnect(): void {
    // noop
  }
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
