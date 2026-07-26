import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type MermaidToExcalidrawModule = {
  parseMermaidToExcalidraw: (
    definition: string,
  ) => Promise<{ elements: unknown[] }>;
};

const loadExcalidrawMermaidConverter = async () => {
  const requireFromExcalidraw = createRequire(
    import.meta.resolve("@excalidraw/excalidraw"),
  );
  const converterUrl = pathToFileURL(
    requireFromExcalidraw.resolve("@excalidraw/mermaid-to-excalidraw"),
  ).href;

  return (await import(
    /* @vite-ignore */ converterUrl
  )) as MermaidToExcalidrawModule;
};

describe("Excalidraw Mermaid security patch", () => {
  const getBBoxDescriptor = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getBBox",
  );
  const getComputedTextLengthDescriptor = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getComputedTextLength",
  );

  beforeAll(() => {
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: function getBBox(this: SVGElement) {
        const text = this.textContent ?? "";
        return {
          x: Number(this.getAttribute("x") ?? 0),
          y: Number(this.getAttribute("y") ?? 0),
          width: Math.max(
            Number(this.getAttribute("width") ?? 0),
            text.length * 8,
            1,
          ),
          height: Math.max(Number(this.getAttribute("height") ?? 0), 16),
        };
      },
    });
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value: function getComputedTextLength(this: SVGElement) {
        return Math.max((this.textContent ?? "").length * 8, 1);
      },
    });
  });

  afterAll(() => {
    if (getBBoxDescriptor) {
      Object.defineProperty(SVGElement.prototype, "getBBox", getBBoxDescriptor);
    } else {
      Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    }
    if (getComputedTextLengthDescriptor) {
      Object.defineProperty(
        SVGElement.prototype,
        "getComputedTextLength",
        getComputedTextLengthDescriptor,
      );
    } else {
      Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
    }
  });

  it("converts a flowchart through Excalidraw's bundled converter", async () => {
    const { parseMermaidToExcalidraw } = await loadExcalidrawMermaidConverter();
    const { elements } = await parseMermaidToExcalidraw(
      "flowchart LR\nA[Start] --> B[Finish]",
    );

    expect(elements.length).toBeGreaterThan(0);
    expect(JSON.stringify(elements)).toContain("Start");
    expect(JSON.stringify(elements)).toContain("Finish");
  });

  it("does not insert an executable sequence label into the DOM", async () => {
    const unsafeInsertion = vi.fn();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches("[onerror]") || node.querySelector("[onerror]"))
          ) {
            unsafeInsertion();
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      const { parseMermaidToExcalidraw } =
        await loadExcalidrawMermaidConverter();
      const { elements } = await parseMermaidToExcalidraw(`sequenceDiagram
        participant A as Alice<img src="x" onerror="document.write('xss')">$$\\text{Alice}$$
        A->>John: Hello John, how are you?`);

      expect(elements.length).toBeGreaterThan(0);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(unsafeInsertion).not.toHaveBeenCalled();
      expect(document.querySelector("[onerror]")).toBeNull();
    } finally {
      observer.disconnect();
    }
  });
});
