/**
 * Upstream's `exportToSvg` keeps element links as plain `<a href>` anchors.
 * On the published page external links must open in a new tab without opener
 * access, and non-web hrefs (Excalidraw-internal element links) are inert in
 * a static SVG, so they are unlinked instead of pointing nowhere.
 */
export function hardenSvgLinks(svg: SVGSVGElement): void {
  for (const anchor of svg.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    } else if (!href.startsWith("mailto:")) {
      anchor.removeAttribute("href");
    }
  }
}
