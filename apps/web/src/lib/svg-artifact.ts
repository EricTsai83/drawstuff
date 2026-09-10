import { hardenSvgLinks } from "@/lib/svg-links";
import { convertImageFiltersToSvgFilters } from "@/lib/svg-image-filters";

/**
 * A published render artifact is an SVG the *owner's* browser produced and
 * uploaded; the public viewer fetches it and mounts it into the live DOM so
 * text stays selectable and `fonts.css` applies. Inline DOM means anything
 * executable inside the file would run for every visitor under the page's
 * `script-src 'unsafe-inline'`, and any `<style>` would restyle the whole page
 * under `style-src 'unsafe-inline'`, so the artifact is treated as untrusted
 * input and reduced to what `exportToSvg` legitimately emits: SVG-namespace
 * shapes, text, `<image>` data URLs (or `<use>` of an in-document `<symbol>`)
 * and `<a>` links. Upstream's only `<style>` is the font-face block, which is
 * empty with `skipInliningFonts` (upstream itself removes `.style-fonts` in
 * its previews), so styles are dropped wholesale rather than parsed.
 *
 * Considered `<img src>` instead: browsers sandbox SVG-as-image completely,
 * but it cannot load the shared `fonts.css` faces (no external resources) and
 * loses text selection — the two reasons the viewer exists.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "animate",
  "animatecolor",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
  "handler",
  "listener",
]);

/**
 * The root sits in the host page's HTML flow: a `style="position:fixed"` or a
 * utility class on it could cover the viewer's controls. Descendants are
 * confined to the SVG viewport, and upstream writes `style` on `<text>`, so
 * they keep theirs.
 */
const FORBIDDEN_ROOT_ATTRIBUTES = new Set(["style", "class"]);

const LOCAL_REFERENCE = /^(#|data:image\/)/i;

function isHrefAttribute(name: string): boolean {
  return name === "href" || name.endsWith(":href");
}

export function sanitizeSvgArtifact(svg: SVGSVGElement): void {
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if (
      element !== svg &&
      (element.namespaceURI !== SVG_NS ||
        FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase()))
    ) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        (element === svg && FORBIDDEN_ROOT_ATTRIBUTES.has(name))
      ) {
        element.removeAttribute(attribute.name);
      } else if (isHrefAttribute(name)) {
        if (element.localName === "a") {
          // `hardenSvgLinks` reads plain `href`; a legacy `xlink:href` would
          // otherwise slip past it. Anchors carry at most one href.
          if (name !== "href") {
            element.removeAttribute(attribute.name);
            if (!element.hasAttribute("href")) {
              element.setAttribute("href", attribute.value);
            }
          }
        } else if (!LOCAL_REFERENCE.test(attribute.value.trim())) {
          // `<image>` and `<use>` may only point at embedded data or at a
          // symbol in the same file; anything remote is dropped.
          element.removeAttribute(attribute.name);
        }
      }
    }
  }
  hardenSvgLinks(svg);
}

/**
 * Parses a fetched artifact into a sanitized `<svg>` element ready to mount.
 * Throws on anything that is not a well-formed SVG document.
 */
export function parsePublishedSvgArtifact(source: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (
    root.querySelector("parsererror") ||
    root.localName === "parsererror" ||
    root.namespaceURI !== SVG_NS ||
    root.localName !== "svg"
  ) {
    throw new Error("Published artifact is not a valid SVG document");
  }
  const svg = root as unknown as SVGSVGElement;
  sanitizeSvgArtifact(svg);
  // Immutable artifacts published before the image-filter fix still carry
  // CSS functions. Normalize those on load too, including theme overrides.
  // Already-converted artifacts keep their existing filter references.
  convertImageFiltersToSvgFilters(svg);
  return svg;
}
