class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // No layout observation is needed in adapter contract tests.
  }
  unobserve(): void {
    // No layout observation is needed in adapter contract tests.
  }
  disconnect(): void {
    // No layout observation is needed in adapter contract tests.
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
