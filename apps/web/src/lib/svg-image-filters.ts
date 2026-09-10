/**
 * Upstream's dark-mode SVG export inverts the whole scene with a CSS filter
 * on the root `<svg>`, then re-inverts every raster image with a second CSS
 * filter written onto the image's `<use>` node (`IMAGE_INVERT_FILTER` in
 * `renderer/renderElement.ts`, which the package does not export).
 *
 * WebKit ignores CSS filter *functions* on SVG child elements — as a
 * presentation attribute, as inline style, or on a wrapping `<g>` — and only
 * honours `filter="url(#id)"` pointing at a real `<filter>`. The root filter
 * still lands, because the outer `<svg>` is a CSS box. So on Safari, and
 * therefore on every iOS browser, the scene is inverted and the per-image
 * correction is not: photos come out colour-inverted. Chromium applies both,
 * which is why the same page looks right on desktop Chrome and on Android.
 *
 * Each distinct function list is compiled once into an equivalent `<filter>`
 * in `<defs>` and the attribute is repointed at it. Only nodes upstream
 * already marked are touched, so its own choice of which images to correct
 * (SVG images are deliberately left uncorrected) is preserved rather than
 * reimplemented here.
 *
 * Runs on the merged artifact, after the two renders are combined, so the
 * `<filter>` definitions exist once in one file. That means the dark value
 * usually lives in a theme override rather than on the node, and both forms
 * are rewritten. The root `<svg>` filter is deliberately left alone: it works
 * in WebKit already, being a CSS box, and the viewer copies it onto an HTML
 * element to paint the backdrop, where a `url(#…)` reference would not mean
 * the same thing.
 */

import { THEME_VARIANTS_ATTRIBUTE } from "@/lib/svg-theme-variants";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Prefixed to stay clear of upstream's `image-*` symbol ids. */
const FILTER_ID_PREFIX = "ds-image-filter";

const FUNCTION_PATTERN = /([a-z-]+)\(([^)]*)\)/gi;

/**
 * `50%` and `0.5` are the same amount to a CSS filter function. Returns
 * `null` for anything that is not a bare number or percentage, so an
 * unsupported unit bails out instead of being silently mis-compiled.
 */
function parseAmount(raw: string): number | null {
  const text = raw.trim();
  const isPercentage = text.endsWith("%");
  const value = Number.parseFloat(isPercentage ? text.slice(0, -1) : text);
  if (!Number.isFinite(value)) return null;
  if (isPercentage) return value / 100;
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text) ? value : null;
}

/** Only `deg` is accepted; upstream writes degrees and other units would need
 *  their own conversion to be trustworthy. */
function parseDegrees(raw: string): number | null {
  const text = raw.trim();
  if (!text.endsWith("deg")) return null;
  const value = Number.parseFloat(text.slice(0, -3));
  return Number.isFinite(value) ? value : null;
}

function colorMatrix(
  doc: Document,
  type: "hueRotate" | "saturate",
  values: string,
): SVGElement {
  const node = doc.createElementNS(SVG_NS, "feColorMatrix");
  node.setAttribute("type", type);
  node.setAttribute("values", values);
  return node;
}

/**
 * Compiles one CSS filter function list into the primitives the Filter
 * Effects spec defines as its equivalent. Returns `null` if any function is
 * unsupported, so the caller can leave the attribute alone rather than
 * change how the artifact looks.
 */
function compileFunctionList(
  doc: Document,
  value: string,
): SVGElement[] | null {
  const primitives: SVGElement[] = [];

  for (const match of value.matchAll(FUNCTION_PATTERN)) {
    const name = (match[1] ?? "").toLowerCase();
    const argument = match[2] ?? "";

    if (name === "invert") {
      const amount = parseAmount(argument);
      if (amount === null) return null;
      const transfer = doc.createElementNS(SVG_NS, "feComponentTransfer");
      for (const channel of ["feFuncR", "feFuncG", "feFuncB"]) {
        const func = doc.createElementNS(SVG_NS, channel);
        func.setAttribute("type", "table");
        func.setAttribute("tableValues", `${amount} ${1 - amount}`);
        transfer.appendChild(func);
      }
      primitives.push(transfer);
      continue;
    }

    if (name === "hue-rotate") {
      const degrees = parseDegrees(argument);
      if (degrees === null) return null;
      primitives.push(colorMatrix(doc, "hueRotate", String(degrees)));
      continue;
    }

    if (name === "saturate") {
      const amount = parseAmount(argument);
      if (amount === null) return null;
      primitives.push(colorMatrix(doc, "saturate", String(amount)));
      continue;
    }

    return null;
  }

  // Whitespace between functions is all that may remain; anything else means
  // the value was not the plain function list this compiler assumes.
  if (primitives.length === 0) return null;
  return value.replace(FUNCTION_PATTERN, "").trim() === "" ? primitives : null;
}

function getDefs(svg: SVGSVGElement): Element {
  const existing = svg.querySelector(":scope > defs");
  if (existing) return existing;
  const defs = svg.ownerDocument.createElementNS(SVG_NS, "defs");
  svg.prepend(defs);
  return defs;
}

/**
 * Rewrites CSS filter functions on the exported scene's image nodes into
 * `<filter>` references so WebKit applies them. Safe to call on both
 * variants: a light export carries no such attribute.
 */
export function convertImageFiltersToSvgFilters(svg: SVGSVGElement): void {
  const imageNodes = [...svg.querySelectorAll("use, image")];

  /** A value is compileable when it is a function list, not a reference. */
  const isCompileable = (value: string | null | undefined): value is string =>
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() !== "none" &&
    !value.trim().startsWith("url(");

  type Override = Record<string, Record<string, string | null>>;
  const overrideOf = (node: Element): Override | null => {
    const raw = node.getAttribute(THEME_VARIANTS_ATTRIBUTE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Override;
    } catch {
      return null;
    }
  };

  // Every distinct value, whether it sits on the node or in an override.
  const values = new Set<string>();
  for (const node of imageNodes) {
    const live = node.getAttribute("filter")?.trim();
    if (isCompileable(live)) values.add(live);
    const override = overrideOf(node);
    if (!override) continue;
    for (const theme of Object.values(override)) {
      const value = theme.filter?.trim();
      if (isCompileable(value)) values.add(value);
    }
  }
  if (values.size === 0) return;

  const doc = svg.ownerDocument;
  const defs = getDefs(svg);
  const referenceByValue = new Map<string, string>();
  let index = 0;

  for (const value of values) {
    const primitives = compileFunctionList(doc, value);
    if (!primitives) {
      console.warn(
        `Unsupported SVG image filter left as-is (Safari will ignore it): ${value}`,
      );
      continue;
    }
    const id = `${FILTER_ID_PREFIX}-${index}`;
    const filter = doc.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", id);
    // CSS filter functions are defined to operate in sRGB; the SVG default is
    // linearRGB, which would darken the result.
    filter.setAttribute("color-interpolation-filters", "sRGB");
    for (const primitive of primitives) filter.appendChild(primitive);
    defs.appendChild(filter);
    referenceByValue.set(value, `url(#${id})`);
    index += 1;
  }

  for (const node of imageNodes) {
    const live = node.getAttribute("filter")?.trim();
    if (isCompileable(live)) {
      const reference = referenceByValue.get(live);
      if (reference) node.setAttribute("filter", reference);
    }

    const override = overrideOf(node);
    if (!override) continue;
    let rewritten = false;
    for (const theme of Object.values(override)) {
      const value = theme.filter?.trim();
      if (!isCompileable(value)) continue;
      const reference = referenceByValue.get(value);
      if (!reference) continue;
      theme.filter = reference;
      rewritten = true;
    }
    if (rewritten) {
      node.setAttribute(THEME_VARIANTS_ATTRIBUTE, JSON.stringify(override));
    }
  }
}
