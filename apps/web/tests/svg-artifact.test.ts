// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  parsePublishedSvgArtifact,
  sanitizeSvgArtifact,
} from "@/lib/svg-artifact";

const SVG_NS = "http://www.w3.org/2000/svg";

const wrap = (body: string, rootAttributes = "") =>
  `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" ${rootAttributes}>${body}</svg>`;

describe("parsePublishedSvgArtifact", () => {
  it("returns the svg root for a well-formed document", () => {
    const svg = parsePublishedSvgArtifact(
      wrap('<rect x="0" y="0" width="10" height="10" fill="#fff"/>'),
    );
    expect(svg.localName).toBe("svg");
    expect(svg.getAttribute("width")).toBe("10");
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#fff");
  });

  it("rejects malformed XML and non-SVG documents", () => {
    expect(() => parsePublishedSvgArtifact("<svg><rect></svg>")).toThrow();
    expect(() =>
      parsePublishedSvgArtifact('<html xmlns="http://www.w3.org/1999/xhtml"/>'),
    ).toThrow();
  });
});

describe("sanitizeSvgArtifact", () => {
  it("removes executable content an owner could have planted", () => {
    const svg = parsePublishedSvgArtifact(
      wrap(
        [
          "<script>alert(1)</script>",
          '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
          '<a href="https://ok.example"><set attributeName="href" to="javascript:alert(1)"/></a>',
          '<rect onload="alert(1)" onclick="alert(1)" width="1" height="1"/>',
          '<text font-family="Excalifont">kept</text>',
        ].join(""),
        'onload="alert(1)"',
      ),
    );

    expect(svg.querySelector("script")).toBeNull();
    expect(svg.querySelector("foreignObject")).toBeNull();
    expect(svg.querySelector("set")).toBeNull();
    expect(svg.hasAttribute("onload")).toBe(false);
    const rect = svg.querySelector("rect")!;
    expect(rect.hasAttribute("onload")).toBe(false);
    expect(rect.hasAttribute("onclick")).toBe(false);
    expect(svg.querySelector("text")?.textContent).toBe("kept");
  });

  it("drops styles, foreign-namespace elements and root styling that could reach the host page", () => {
    const svg = parsePublishedSvgArtifact(
      wrap(
        [
          '<style class="style-fonts">body > main { display: none !important }</style>',
          '<div xmlns="http://www.w3.org/1999/xhtml" style="position:fixed;inset:0">overlay</div>',
          '<text style="white-space: pre" font-family="Excalifont">kept</text>',
        ].join(""),
        'style="position:fixed;inset:0;z-index:50" class="fixed inset-0" filter="invert(93%) hue-rotate(180deg)"',
      ),
    );

    expect(svg.querySelector("style")).toBeNull();
    expect([...svg.children].map((child) => child.localName)).toEqual(["text"]);
    expect(svg.hasAttribute("style")).toBe(false);
    expect(svg.hasAttribute("class")).toBe(false);
    // Upstream's dark-mode filter is an attribute the backdrop reads back.
    expect(svg.getAttribute("filter")).toBe("invert(93%) hue-rotate(180deg)");
    // Descendants keep the inline styles upstream writes on <text>.
    expect(svg.querySelector("text")?.getAttribute("style")).toBe(
      "white-space: pre",
    );
  });

  it("keeps embedded images and in-document symbol references, drops remote ones", () => {
    const svg = parsePublishedSvgArtifact(
      wrap(
        [
          '<symbol id="image-1"><image href="data:image/png;base64,AAAA" width="1" height="1"/></symbol>',
          '<use href="#image-1"/>',
          '<image href="https://tracker.example/pixel.png" width="1" height="1"/>',
          '<use xlink:href="https://evil.example/sprite.svg#x"/>',
        ].join(""),
      ),
    );

    const hrefOf = (selector: string) =>
      [...svg.querySelectorAll(selector)].map(
        (element) =>
          element.getAttribute("href") ?? element.getAttribute("xlink:href"),
      );
    expect(hrefOf("image")).toEqual(["data:image/png;base64,AAAA", null]);
    expect(hrefOf("use")).toEqual(["#image-1", null]);
  });

  it("hardens links, including legacy xlink anchors", () => {
    const svg = parsePublishedSvgArtifact(
      wrap(
        [
          '<a href="https://ok.example"><text>web</text></a>',
          '<a xlink:href="javascript:alert(1)"><text>js</text></a>',
          '<a href="excalidraw://element/abc"><text>internal</text></a>',
        ].join(""),
      ),
    );

    const anchors = [...svg.querySelectorAll("a")];
    expect(anchors[0]?.getAttribute("target")).toBe("_blank");
    expect(anchors[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchors[1]?.hasAttribute("href")).toBe(false);
    expect(anchors[1]?.hasAttribute("xlink:href")).toBe(false);
    expect(anchors[2]?.hasAttribute("href")).toBe(false);
  });

  it("is idempotent on an already clean export", () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("font-family", "Excalifont");
    text.textContent = "hello";
    svg.appendChild(text);
    const before = svg.outerHTML;

    sanitizeSvgArtifact(svg);

    expect(svg.outerHTML).toBe(before);
  });
});
