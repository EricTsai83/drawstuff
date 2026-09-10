/**
 * Light and dark exports of the same scene are byte-identical apart from a
 * handful of attributes: upstream's root inversion filter, the counter-filter
 * on each raster image, and the frame-label colour. Measured on the published
 * artifacts in production, a real pair differs by 40 bytes out of 37 kB.
 * Storing two whole files to encode that is wasteful, and it makes a theme
 * switch cost a second download of everything, images included.
 *
 * So the two renders are merged into one artifact here. Rather than deciding
 * *which* attributes are theme-dependent — that is upstream's business and
 * re-implementing it is how the viewer would silently drift from the engine —
 * the merge diffs upstream's own two outputs and records whatever actually
 * differs. A future engine that changes dark mode in some new way is captured
 * automatically.
 *
 * The recorded overrides travel in one attribute per differing element, so
 * the viewer can switch themes by writing attributes with no network at all.
 */

/** Marks an element whose appearance depends on the theme. */
export const THEME_VARIANTS_ATTRIBUTE = "data-theme-variants";

export type ArtifactTheme = "light" | "dark";

/** `null` means the attribute is absent in that theme and must be removed. */
type AttributeOverrides = Record<string, string | null>;

type ThemeVariants = Record<ArtifactTheme, AttributeOverrides>;

function readAttributes(element: Element): Map<string, string> {
  return new Map(
    [...element.attributes].map((attribute) => [
      attribute.name,
      attribute.value,
    ]),
  );
}

/**
 * Both themes' values for every attribute that differs, or `null` when the
 * element is identical in both.
 */
function diffAttributes(light: Element, dark: Element): ThemeVariants | null {
  const lightAttributes = readAttributes(light);
  const darkAttributes = readAttributes(dark);
  const names = new Set([...lightAttributes.keys(), ...darkAttributes.keys()]);

  const variants: ThemeVariants = { light: {}, dark: {} };
  let differs = false;
  for (const name of names) {
    const lightValue = lightAttributes.get(name) ?? null;
    const darkValue = darkAttributes.get(name) ?? null;
    if (lightValue === darkValue) continue;
    variants.light[name] = lightValue;
    variants.dark[name] = darkValue;
    differs = true;
  }
  return differs ? variants : null;
}

/**
 * Merges the dark render's differences into the light one, which becomes the
 * single artifact. The light tree is mutated and returned.
 *
 * Walks both trees in lockstep. The two renders describe the same scene, so
 * they are expected to have identical structure; a divergence means the
 * engine started varying more than attributes by theme. That is reported and
 * the subtree is left at its light appearance rather than failing the
 * author's save. `tests/published-artifact-theme-drift.test.ts` fails on the
 * same condition, so an engine upgrade surfaces it before it ships.
 */
export function mergeThemeVariants(
  light: SVGSVGElement,
  dark: SVGSVGElement,
): SVGSVGElement {
  let divergences = 0;

  const visit = (lightNode: Element, darkNode: Element): void => {
    if (
      lightNode.localName !== darkNode.localName ||
      lightNode.children.length !== darkNode.children.length ||
      lightNode.textContent !== darkNode.textContent
    ) {
      divergences += 1;
      return;
    }

    const variants = diffAttributes(lightNode, darkNode);
    if (variants) {
      lightNode.setAttribute(
        THEME_VARIANTS_ATTRIBUTE,
        JSON.stringify(variants),
      );
    }

    for (const [index, lightChild] of [...lightNode.children].entries()) {
      const darkChild = darkNode.children[index];
      if (darkChild) visit(lightChild, darkChild);
    }
  };

  visit(light, dark);

  if (divergences > 0) {
    console.warn(
      `Published artifact: ${divergences} element(s) differ structurally between themes; dark mode will show the light appearance there.`,
    );
  }
  return light;
}

/**
 * Switches a merged artifact to one theme. Overrides are the only source of
 * theming here, so this is idempotent and an artifact carrying none simply
 * renders as itself rather than being a case to special-case.
 */
export function applyArtifactTheme(
  svg: SVGSVGElement,
  theme: ArtifactTheme,
): void {
  const targets = svg.hasAttribute(THEME_VARIANTS_ATTRIBUTE)
    ? [svg, ...svg.querySelectorAll(`[${THEME_VARIANTS_ATTRIBUTE}]`)]
    : [...svg.querySelectorAll(`[${THEME_VARIANTS_ATTRIBUTE}]`)];

  for (const element of targets) {
    const raw = element.getAttribute(THEME_VARIANTS_ATTRIBUTE);
    if (!raw) continue;

    let variants: ThemeVariants;
    try {
      variants = JSON.parse(raw) as ThemeVariants;
    } catch {
      // A malformed artifact must still render, just without theming.
      console.warn("Published artifact: unreadable theme overrides, ignoring.");
      continue;
    }

    const overrides = variants[theme];
    if (!overrides) continue;
    for (const [name, value] of Object.entries(overrides)) {
      // Never let the marker itself be rewritten by its own payload.
      if (name === THEME_VARIANTS_ATTRIBUTE) continue;
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
  }
}
