import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // Layout observation is not needed in jsdom contract tests.
  }

  unobserve(): void {
    // Layout observation is not needed in jsdom contract tests.
  }

  disconnect(): void {
    // Layout observation is not needed in jsdom contract tests.
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

class FontFaceStub {
  readonly status = "loaded";
  readonly loaded = Promise.resolve(this);

  constructor(
    readonly family: string,
    readonly source: string | ArrayBuffer,
  ) {}

  async load(): Promise<FontFaceStub> {
    return this;
  }
}

Object.defineProperty(globalThis, "FontFace", {
  configurable: true,
  value: FontFaceStub,
});

if (typeof document !== "undefined") {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: () => document.fonts,
      check: () => true,
      clear: () => undefined,
      delete: () => true,
      has: () => true,
      ready: Promise.resolve(),
    },
  });
}
