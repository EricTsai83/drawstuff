// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyArtifactTheme,
  mergeThemeVariants,
  THEME_VARIANTS_ATTRIBUTE,
} from "@/lib/svg-theme-variants";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Upstream's real dark-mode values. */
const ROOT_FILTER = "invert(93%) hue-rotate(180deg)";
const IMAGE_FILTER = "url(#ds-image-filter-0)";

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

/**
 * A scene shaped like a real export: a background rect, an image placement
 * and a frame label, built for one theme.
 */
function buildVariant(theme: "light" | "dark"): SVGSVGElement {
  const dark = theme === "dark";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "200");
  if (dark) svg.setAttribute("filter", ROOT_FILTER);

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("fill", "#ffffff");
  svg.appendChild(rect);

  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#image-1");
  if (dark) use.setAttribute("filter", IMAGE_FILTER);
  svg.appendChild(use);

  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("fill", dark ? "#7a7a7a" : "#999999");
  label.textContent = "Frame 1";
  svg.appendChild(label);

  return svg;
}

const overridesOf = (element: Element) =>
  JSON.parse(
    required(element.getAttribute(THEME_VARIANTS_ATTRIBUTE), "marker"),
  ) as {
    light: Record<string, string | null>;
    dark: Record<string, string | null>;
  };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mergeThemeVariants", () => {
  it("records every attribute that differs and nothing that does not", () => {
    const merged = mergeThemeVariants(
      buildVariant("light"),
      buildVariant("dark"),
    );

    // Root: gains a filter in dark.
    expect(overridesOf(merged)).toEqual({
      light: { filter: null },
      dark: { filter: ROOT_FILTER },
    });

    // The unchanged background rect stays unmarked.
    const rect = required(merged.querySelector("rect"), "rect");
    expect(rect.hasAttribute(THEME_VARIANTS_ATTRIBUTE)).toBe(false);

    // The image gains its counter-filter in dark.
    const use = required(merged.querySelector("use"), "use");
    expect(overridesOf(use)).toEqual({
      light: { filter: null },
      dark: { filter: IMAGE_FILTER },
    });

    // The frame label changes colour rather than gaining an attribute.
    const label = required(merged.querySelector("text"), "text");
    expect(overridesOf(label)).toEqual({
      light: { fill: "#999999" },
      dark: { fill: "#7a7a7a" },
    });
  });

  it("keeps the light appearance as the artifact's own state", () => {
    const merged = mergeThemeVariants(
      buildVariant("light"),
      buildVariant("dark"),
    );

    expect(merged.hasAttribute("filter")).toBe(false);
    expect(merged.querySelector("use")?.hasAttribute("filter")).toBe(false);
    expect(merged.querySelector("text")?.getAttribute("fill")).toBe("#999999");
  });

  it("reports a structural divergence instead of failing the save", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const light = buildVariant("light");
    const dark = buildVariant("dark");
    dark.appendChild(document.createElementNS(SVG_NS, "circle"));

    const merged = mergeThemeVariants(light, dark);

    expect(warn).toHaveBeenCalledOnce();
    // The light tree is still usable; it simply carries no overrides.
    expect(merged.hasAttribute(THEME_VARIANTS_ATTRIBUTE)).toBe(false);
  });
});

describe("applyArtifactTheme", () => {
  it("round-trips between the two themes", () => {
    const merged = mergeThemeVariants(
      buildVariant("light"),
      buildVariant("dark"),
    );
    const use = required(merged.querySelector("use"), "use");
    const label = required(merged.querySelector("text"), "text");

    applyArtifactTheme(merged, "dark");
    expect(merged.getAttribute("filter")).toBe(ROOT_FILTER);
    expect(use.getAttribute("filter")).toBe(IMAGE_FILTER);
    expect(label.getAttribute("fill")).toBe("#7a7a7a");

    applyArtifactTheme(merged, "light");
    expect(merged.hasAttribute("filter")).toBe(false);
    expect(use.hasAttribute("filter")).toBe(false);
    expect(label.getAttribute("fill")).toBe("#999999");

    // Switching twice in a row must not accumulate state.
    applyArtifactTheme(merged, "dark");
    applyArtifactTheme(merged, "dark");
    expect(merged.getAttribute("filter")).toBe(ROOT_FILTER);
  });

  it("reproduces each engine render exactly", () => {
    const merged = mergeThemeVariants(
      buildVariant("light"),
      buildVariant("dark"),
    );
    // Compared structurally, not as serialised text: `setAttribute` appends,
    // so a restored attribute lands in a different position than the engine
    // wrote it. Attribute order carries no meaning in XML, and the real
    // production artifact differs from its engine render in exactly that way
    // and no other.
    const shape = (svg: SVGSVGElement) =>
      [svg, ...svg.querySelectorAll("*")].map((element) => ({
        tag: element.localName,
        text: element.textContent,
        attributes: [...element.attributes]
          .filter((attribute) => attribute.name !== THEME_VARIANTS_ATTRIBUTE)
          .map((attribute) => `${attribute.name}=${attribute.value}`)
          .sort(),
      }));

    applyArtifactTheme(merged, "dark");
    expect(shape(merged)).toEqual(shape(buildVariant("dark")));

    applyArtifactTheme(merged, "light");
    expect(shape(merged)).toEqual(shape(buildVariant("light")));
  });

  it("leaves an SVG carrying no overrides untouched", () => {
    const plain = buildVariant("light");
    const before = new XMLSerializer().serializeToString(plain);

    applyArtifactTheme(plain, "dark");

    expect(new XMLSerializer().serializeToString(plain)).toBe(before);
  });

  it("renders unthemed rather than throwing on a malformed marker", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const svg = buildVariant("light");
    svg.setAttribute(THEME_VARIANTS_ATTRIBUTE, "{not json");

    applyArtifactTheme(svg, "dark");

    expect(warn).toHaveBeenCalledOnce();
    expect(svg.hasAttribute("filter")).toBe(false);
  });
});
