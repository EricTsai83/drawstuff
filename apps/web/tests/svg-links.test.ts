import { describe, expect, it } from "vitest";
import { hardenSvgLinks } from "@/lib/svg-links";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgWithAnchors(hrefs: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const href of hrefs) {
    const anchor = document.createElementNS(SVG_NS, "a");
    anchor.setAttribute("href", href);
    svg.appendChild(anchor);
  }
  return svg;
}

describe("hardenSvgLinks", () => {
  it("opens web links in a new tab without opener access", () => {
    const svg = svgWithAnchors(["https://example.com", "http://example.com"]);

    hardenSvgLinks(svg);

    for (const anchor of svg.querySelectorAll("a")) {
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("unlinks Excalidraw-internal element links", () => {
    const svg = svgWithAnchors(["excalidraw://element/abc", "#frame-1"]);

    hardenSvgLinks(svg);

    for (const anchor of svg.querySelectorAll("a")) {
      expect(anchor.hasAttribute("href")).toBe(false);
      expect(anchor.hasAttribute("target")).toBe(false);
    }
  });

  it("leaves mailto links untouched", () => {
    const svg = svgWithAnchors(["mailto:hi@example.com"]);

    hardenSvgLinks(svg);

    const anchor = svg.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("mailto:hi@example.com");
    expect(anchor?.hasAttribute("target")).toBe(false);
  });
});
