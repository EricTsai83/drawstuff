import { describe, expect, it, vi } from "vitest";
import { exportSceneToSvg } from "@drawstuff/excalidraw-adapter/client";
import type {
  BinaryFiles,
  ExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import { renderPublishedArtifacts } from "@/lib/render-published-artifacts";
import { convertImageFiltersToSvgFilters } from "@/lib/svg-image-filters";
import {
  applyArtifactTheme,
  mergeThemeVariants,
  THEME_VARIANTS_ATTRIBUTE,
} from "@/lib/svg-theme-variants";

/**
 * The single published artifact assumes the engine's light and dark renders
 * differ only in attributes, so the difference can be recorded and replayed.
 * That is true of Excalidraw today — the root inversion filter, the
 * counter-filter on raster images, and the frame-label colour — but it is the
 * engine's business, not ours.
 *
 * This runs the real engine rather than a double, so an upgrade that starts
 * varying structure by theme fails here instead of silently shipping a dark
 * mode that renders as light.
 */

// A 2x2 red PNG: enough for the engine to treat it as a raster image and add
// the dark-mode counter-filter that a vector-only scene would never show.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYkBBkAcAB0EAgFsyBpFAAAAAElFTkSuQmCC";

const base = {
  isDeleted: false,
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  angle: 0,
  seed: 1,
  version: 1,
  versionNonce: 1,
  updated: 1,
  groupIds: [],
  frameId: null,
  roundness: null,
  boundElements: null,
  link: null,
  locked: false,
  index: null,
} as const;

const elements = [
  {
    ...base,
    id: "rect-1",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 80,
    height: 40,
    strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff",
  },
  {
    ...base,
    id: "text-1",
    type: "text",
    x: 0,
    y: 60,
    width: 60,
    height: 20,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    text: "Label",
    originalText: "Label",
    fontSize: 16,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
  },
  {
    ...base,
    id: "image-1",
    type: "image",
    x: 0,
    y: 100,
    width: 40,
    height: 40,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fileId: "file-1",
    status: "saved",
    scale: [1, 1],
    crop: null,
  },
] as unknown as ExcalidrawElement[];

const files = {
  "file-1": {
    id: "file-1",
    mimeType: "image/png",
    dataURL: PNG,
    created: 1,
    lastRetrieved: 1,
  },
} as unknown as BinaryFiles;

async function render(exportWithDarkMode: boolean) {
  const svg = await exportSceneToSvg({
    elements,
    appState: {
      exportWithDarkMode,
      exportBackground: true,
      exportEmbedScene: false,
      exportScale: 1,
      viewBackgroundColor: "#ffffff",
    },
    files,
    skipInliningFonts: true,
  });
  // Deliberately raw: the merge walks the engine's two trees in lockstep, so
  // it must see them before any post-processing. `convertImageFiltersToSvgFilters`
  // adds `<filter>` nodes to whichever tree carries an image filter, which is
  // exactly the structural divergence that would break the merge if it ran
  // first — this test is what caught that ordering.
  return svg;
}

/** Tag, text and sorted attributes of every node, ignoring the merge marker. */
const shapeOf = (svg: SVGSVGElement) =>
  [svg, ...svg.querySelectorAll("*")].map((element) => ({
    tag: element.localName,
    attributes: [...element.attributes]
      .filter((attribute) => attribute.name !== THEME_VARIANTS_ATTRIBUTE)
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .sort(),
  }));

/**
 * Whether each image node is filtered, without depending on how the filter is
 * spelled: the engine writes a function list and the converter turns it into
 * a reference, so the value differs by design while the theming must not.
 */
const themedAttributes = (svg: SVGSVGElement) => ({
  rootFilter: svg.getAttribute("filter"),
  imagesFiltered: [...svg.querySelectorAll("use, image")].map((node) =>
    node.hasAttribute("filter"),
  ),
});

describe("published artifact theme drift", () => {
  it("captures the engine's whole light/dark difference in one artifact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const [light, dark] = await Promise.all([render(false), render(true)]);
    const lightShape = shapeOf(light);
    const darkShape = shapeOf(dark);

    // Guards the premise: if these were already equal the test would prove
    // nothing, and if they differed structurally the merge could not work.
    expect(lightShape).not.toEqual(darkShape);
    expect(lightShape.map(({ tag }) => tag)).toEqual(
      darkShape.map(({ tag }) => tag),
    );

    const merged = mergeThemeVariants(light, await render(true));
    // No structural divergence was reported.
    expect(warn).not.toHaveBeenCalled();
    // Post-processing runs on the merged tree, as in production.
    convertImageFiltersToSvgFilters(merged);

    // Compared by tag sequence and by the attributes the engine set: the
    // converter has since replaced the image filter's value with a reference
    // and added its definition, both intended.
    applyArtifactTheme(merged, "dark");
    expect(themedAttributes(merged)).toEqual(themedAttributes(dark));

    applyArtifactTheme(merged, "light");
    expect(themedAttributes(merged)).toEqual(themedAttributes(light));
  }, 30000);

  it("still differs only in the attributes we know about", async () => {
    const [light, dark] = await Promise.all([render(false), render(true)]);
    const merged = mergeThemeVariants(light, dark);

    const changed = new Set<string>();
    for (const element of [
      merged,
      ...merged.querySelectorAll(`[${THEME_VARIANTS_ATTRIBUTE}]`),
    ]) {
      const raw = element.getAttribute(THEME_VARIANTS_ATTRIBUTE);
      if (!raw) continue;
      const variants = JSON.parse(raw) as { dark: Record<string, unknown> };
      for (const name of Object.keys(variants.dark)) changed.add(name);
    }

    // A new name here is not a failure of this code — it is the engine
    // theming something new. Look at it, then add it.
    expect([...changed].sort()).toEqual(["filter"]);
  }, 30000);

  it("ships the WebKit-safe image filter inside the dark override", async () => {
    // End to end through the shipped pipeline. The Safari fix and the merge
    // touch the same nodes, so this is where one could silently undo the
    // other: the counter-filter has to survive as a `url(#…)` reference in
    // the recorded dark value, with its definition present in the one file.
    const { artifact } = await renderPublishedArtifacts(
      { elements, appState: { viewBackgroundColor: "#ffffff" }, files },
      // jsdom cannot decode an image on a canvas, so the real encoder would
      // sit out its ten-second timeout before keeping the original anyway.
      { encodeImage: () => Promise.resolve(null) },
    );
    // Parsed as HTML, not XML: jsdom's `XMLSerializer` emits a second
    // `xmlns` on the root that a real browser does not, and the strict XML
    // parser rejects it. Production artifacts carry exactly one.
    const svg = new DOMParser()
      .parseFromString(await artifact.text(), "text/html")
      .querySelector("svg");
    expect(svg).not.toBeNull();

    const image = svg?.querySelector(`use[${THEME_VARIANTS_ATTRIBUTE}]`);
    expect(image).not.toBeNull();
    const variants = JSON.parse(
      image?.getAttribute(THEME_VARIANTS_ATTRIBUTE) ?? "{}",
    ) as { light: { filter: string | null }; dark: { filter: string } };

    expect(variants.light.filter).toBeNull();
    const reference = /^url\(#(.+)\)$/.exec(variants.dark.filter);
    expect(reference).not.toBeNull();
    // The referenced definition travels in the same file.
    expect(svg?.querySelector(`defs filter#${reference?.[1]}`)).not.toBeNull();
    expect(artifact.type).toBe("image/svg+xml");
  }, 30000);
});
