import {
  exportSceneToSvg,
  type ExcalidrawSvgExportOptions,
} from "@drawstuff/excalidraw-adapter/client";
import { EXCALIDRAW_ENGINE_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawElement,
  NonDeleted,
} from "@drawstuff/excalidraw-adapter/types";

import { convertImageFiltersToSvgFilters } from "@/lib/svg-image-filters";
import { hardenSvgLinks } from "@/lib/svg-links";
import { mergeThemeVariants } from "@/lib/svg-theme-variants";

/**
 * "Render once, serve many" (docs/system-design/render-once-serve-many.md):
 * the published page used to run this export in every visitor's browser. It
 * now runs here, in the author's browser at save/publish time, and the result
 * is uploaded as one immutable object the viewer only downloads.
 *
 * Both themes travel in that single object. The engine's light and dark
 * renders are byte-identical apart from a few attributes — measured on
 * production artifacts, a real pair differed by 40 bytes out of 37 kB, and
 * one carrying a photo by 96 bytes out of 369 kB — so shipping two files
 * doubled storage and made a theme switch re-download every embedded image.
 * `mergeThemeVariants` records the difference instead.
 *
 * Pure with respect to where it runs: the same inputs the editor holds produce
 * the same artifact whether called from `use-cloud-upload`, the publish
 * action, or — should batch re-rendering ever be needed — a headless browser.
 */
export type RenderedPublishedArtifacts = {
  /** One SVG serving both themes; the viewer toggles it with no network. */
  artifact: Blob;
  /** The engine that produced it; stored beside it so drift is visible. */
  engineVersion: string;
};

export type RenderPublishedArtifactsInput = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

const PUBLISHED_ARTIFACT_MIME_TYPE = "image/svg+xml";

/**
 * `exportToSvg` embeds every image as a data URL, so the artifact carries the
 * bytes of each picture (base64, +33%). The editor already caps images at
 * 1440px, but pasted PNG screenshots still weigh 1–2 MB each and a handful
 * push a public page past the size where first paint suffers. Before export,
 * raster images are re-encoded as WebP and the smaller encoding wins; the
 * editor's own copy in `files` is untouched. Lossless-only formats (SVG),
 * animated ones (GIF) and already-efficient ones (WebP, AVIF) are skipped.
 */
const REENCODABLE_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/jfif",
  "image/bmp",
]);

export const ARTIFACT_IMAGE_QUALITY = 0.85;

/** Bounds a decode that never settles (no real canvas), keeping the original. */
const IMAGE_ENCODE_TIMEOUT_MS = 10_000;

export type ArtifactImageEncoder = (
  dataURL: string,
  quality: number,
) => Promise<string | null>;

function loadImage(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Artifact image failed to decode"));
    image.src = dataURL;
  });
}

/** Browser encoder: canvas → WebP data URL; `null` when WebP is unsupported. */
const encodeImageAsWebp: ArtifactImageEncoder = async (dataURL, quality) => {
  const image = await loadImage(dataURL);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0 || canvas.height === 0) return null;
  context.drawImage(image, 0, 0);
  const encoded = canvas.toDataURL("image/webp", quality);
  // Browsers without a WebP encoder silently return PNG instead.
  return encoded.startsWith("data:image/webp") ? encoded : null;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Artifact image encode timed out")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Returns a copy of `files` where every re-encodable image has been replaced
 * by its WebP encoding when — and only when — that is smaller. Any failure
 * (unsupported format, decode error, timeout, no canvas) keeps the original,
 * so optimisation can never cost a picture.
 */
export async function optimizeArtifactFiles(
  files: BinaryFiles,
  encode: ArtifactImageEncoder = encodeImageAsWebp,
): Promise<BinaryFiles> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([fileId, file]) => {
      if (!REENCODABLE_MIME_TYPES.has(file.mimeType)) return [fileId, file];
      try {
        const encoded = await withTimeout(
          encode(file.dataURL, ARTIFACT_IMAGE_QUALITY),
          IMAGE_ENCODE_TIMEOUT_MS,
        );
        if (!encoded || encoded.length >= file.dataURL.length) {
          return [fileId, file];
        }
        const optimized: BinaryFileData = {
          ...file,
          mimeType: "image/webp",
          dataURL: encoded as DataURL,
        };
        return [fileId, optimized];
      } catch (error) {
        console.warn("Keeping original image for published artifact:", error);
        return [fileId, file];
      }
    }),
  );
  return Object.fromEntries(entries) as BinaryFiles;
}

function isNotDeleted(
  element: ExcalidrawElement,
): element is NonDeleted<ExcalidrawElement> {
  return !element.isDeleted;
}

async function renderVariant(
  input: RenderPublishedArtifactsInput,
  elements: readonly NonDeleted<ExcalidrawElement>[],
  files: BinaryFiles,
  exportWithDarkMode: boolean,
): Promise<SVGSVGElement> {
  const appState: NonNullable<ExcalidrawSvgExportOptions["appState"]> = {
    ...input.appState,
    // Rendered by the engine per theme, then merged. The viewer never
    // derives dark mode itself: upstream inverts the root and re-inverts
    // every <image> so photos stay positive, and restating which attributes
    // that touches is exactly how the artifact would drift from the engine.
    exportWithDarkMode,
    // Keep the scene's own background, exactly like the editor; dropping it
    // made light strokes on a dark scene vanish against the page.
    exportBackground: true,
    // Never carry the author's export dialog settings into the public file.
    exportEmbedScene: false,
    exportScale: 1,
  };
  const svg = await exportSceneToSvg({
    elements,
    appState,
    files,
    // Fonts come from /excalidraw-assets/fonts.css on the viewer, so the
    // artifact stays small and never runs the subsetting worker + wasm.
    skipInliningFonts: true,
  });
  return svg;
}

export async function renderPublishedArtifacts(
  input: RenderPublishedArtifactsInput,
  options: { encodeImage?: ArtifactImageEncoder } = {},
): Promise<RenderedPublishedArtifacts> {
  // `exportToSvg` renders exactly the elements it is given; tombstones from
  // the collaboration-aware snapshot must be dropped here.
  const elements = input.elements.filter(isNotDeleted);
  // Both renders embed the same bytes, so the images are optimised once —
  // and after the merge they are stored once, not twice.
  const files = await optimizeArtifactFiles(input.files, options.encodeImage);
  const [light, dark] = await Promise.all([
    renderVariant(input, elements, files, false),
    renderVariant(input, elements, files, true),
  ]);
  // The light render becomes the artifact and carries the dark render's
  // differences as overrides, so which attributes are theme-dependent stays
  // the engine's decision rather than something restated here. The merge
  // walks the two trees in lockstep, so it has to see them exactly as the
  // engine produced them; both post-processing steps run afterwards, on the
  // one tree that ships.
  const merged = mergeThemeVariants(light, dark);
  // Done at render time; the viewer no longer post-processes links.
  hardenSvgLinks(merged);
  // The dark variant's per-image colour correction, which upstream writes in
  // a form WebKit ignores, now lives in a theme override; the converter
  // rewrites it there as well as on the node.
  convertImageFiltersToSvgFilters(merged);
  const artifact = new Blob([new XMLSerializer().serializeToString(merged)], {
    type: PUBLISHED_ARTIFACT_MIME_TYPE,
  });
  return { artifact, engineVersion: EXCALIDRAW_ENGINE_VERSION };
}
