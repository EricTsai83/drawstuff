// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePublishedSvgArtifact } from "@/lib/svg-artifact";
import { convertImageFiltersToSvgFilters } from "@/lib/svg-image-filters";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Exactly what upstream writes onto a raster image in a dark export. */
const IMAGE_INVERT_FILTER = "invert(100%) hue-rotate(180deg) saturate(1.25)";

function buildSvg(filters: (string | null)[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const defs = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(defs);
  for (const [index, filter] of filters.entries()) {
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#image-${index}`);
    if (filter !== null) use.setAttribute("filter", filter);
    svg.appendChild(use);
  }
  return svg;
}

const filterDefs = (svg: SVGSVGElement) => [
  ...svg.querySelectorAll("defs > filter"),
];

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("convertImageFiltersToSvgFilters", () => {
  it("repoints upstream's image filter at an equivalent <filter>", () => {
    const svg = buildSvg([IMAGE_INVERT_FILTER]);

    convertImageFiltersToSvgFilters(svg);

    const filter = required(filterDefs(svg)[0], "image filter definition");
    const id = filter.getAttribute("id");
    expect(svg.querySelector("use")?.getAttribute("filter")).toBe(
      `url(#${id})`,
    );
    // CSS filter functions are specified in sRGB; linearRGB would darken.
    expect(filter.getAttribute("color-interpolation-filters")).toBe("sRGB");

    const primitives = [...filter.children].map((node) => node.tagName);
    expect(primitives).toEqual([
      "feComponentTransfer",
      "feColorMatrix",
      "feColorMatrix",
    ]);
    // Traversed by `children`: a CSS type selector is lower-cased and would
    // not match these case-sensitive SVG tag names in jsdom.
    const transfer = required(filter.children[0], "feComponentTransfer");
    expect(
      [...transfer.children].map((node) => [
        node.tagName,
        node.getAttribute("type"),
        node.getAttribute("tableValues"),
      ]),
    ).toEqual([
      ["feFuncR", "table", "1 0"],
      ["feFuncG", "table", "1 0"],
      ["feFuncB", "table", "1 0"],
    ]);
    const hueRotate = required(filter.children[1], "hue-rotate primitive");
    const saturate = required(filter.children[2], "saturate primitive");
    expect(hueRotate.getAttribute("type")).toBe("hueRotate");
    expect(hueRotate.getAttribute("values")).toBe("180");
    expect(saturate.getAttribute("type")).toBe("saturate");
    expect(saturate.getAttribute("values")).toBe("1.25");
  });

  it("emits one shared definition per distinct filter value", () => {
    const svg = buildSvg([
      IMAGE_INVERT_FILTER,
      IMAGE_INVERT_FILTER,
      "invert(50%)",
    ]);

    convertImageFiltersToSvgFilters(svg);

    expect(filterDefs(svg)).toHaveLength(2);
    const applied = [...svg.querySelectorAll("use")].map((node) =>
      node.getAttribute("filter"),
    );
    expect(applied[0]).toBe(applied[1]);
    expect(applied[2]).not.toBe(applied[0]);
    // A percentage amount becomes the equivalent 0..1 table.
    const half = required(filterDefs(svg)[1], "invert(50%) definition");
    const transfer = required(half.children[0], "feComponentTransfer");
    expect(
      required(transfer.children[0], "feFuncR").getAttribute("tableValues"),
    ).toBe("0.5 0.5");
  });

  it("leaves a light export untouched", () => {
    const svg = buildSvg([null, null]);

    convertImageFiltersToSvgFilters(svg);

    expect(filterDefs(svg)).toHaveLength(0);
  });

  it("leaves existing references and `none` alone", () => {
    const svg = buildSvg(["url(#already)", "none"]);

    convertImageFiltersToSvgFilters(svg);

    expect(filterDefs(svg)).toHaveLength(0);
    const applied = [...svg.querySelectorAll("use")].map((node) =>
      node.getAttribute("filter"),
    );
    expect(applied).toEqual(["url(#already)", "none"]);
  });

  it("warns and keeps the attribute when a function is not supported", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const svg = buildSvg(["invert(100%) blur(2px)"]);

    convertImageFiltersToSvgFilters(svg);

    expect(filterDefs(svg)).toHaveLength(0);
    expect(svg.querySelector("use")?.getAttribute("filter")).toBe(
      "invert(100%) blur(2px)",
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects an angle unit it cannot convert", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const svg = buildSvg(["hue-rotate(0.5turn)"]);

    convertImageFiltersToSvgFilters(svg);

    expect(filterDefs(svg)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("creates <defs> when the export has none", () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    const image = document.createElementNS(SVG_NS, "image");
    image.setAttribute("filter", IMAGE_INVERT_FILTER);
    svg.appendChild(image);

    convertImageFiltersToSvgFilters(svg);

    expect(filterDefs(svg)).toHaveLength(1);
    expect(image.getAttribute("filter")).toMatch(/^url\(#/);
  });

  it("survives the viewer's sanitizer", () => {
    // The sanitizer drops anything upstream would not emit. It works from a
    // denylist, so a later tightening could silently strip these definitions
    // and bring the Safari bug back with no other test failing.
    const svg = buildSvg([IMAGE_INVERT_FILTER]);
    convertImageFiltersToSvgFilters(svg);
    const reference = required(
      svg.querySelector("use"),
      "image node",
    ).getAttribute("filter");

    const parsed = parsePublishedSvgArtifact(
      new XMLSerializer().serializeToString(svg),
    );

    expect(filterDefs(parsed)).toHaveLength(1);
    expect(parsed.querySelector("use")?.getAttribute("filter")).toBe(reference);
    expect(
      required(filterDefs(parsed)[0], "definition").getAttribute(
        "color-interpolation-filters",
      ),
    ).toBe("sRGB");
  });
});
