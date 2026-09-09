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

import { hardenSvgLinks } from "@/lib/svg-links";

/**
 * "Render once, serve many" (docs/system-design/render-once-serve-many.md):
 * the published page used to run this export in every visitor's browser. It
 * now runs here, in the author's browser at save/publish time, and the result
 * is uploaded as two immutable objects the viewer only downloads.
 *
 * Pure with respect to where it runs: the same inputs the editor holds produce
 * the same pair whether called from `use-cloud-upload`, the publish action, or
 * — should batch re-rendering ever be needed — a headless browser.
 */
export type RenderedPublishedArtifacts = {
  light: Blob;
  dark: Blob;
  /** The engine that produced the pair; stored beside it so drift is visible. */
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
): Promise<Blob> {
  const appState: NonNullable<ExcalidrawSvgExportOptions["appState"]> = {
    ...input.appState,
    // Two variants by the engine rather than one plus a viewer-side filter:
    // upstream dark mode inverts the root and re-inverts every <image> so
    // photos stay positive — logic that must not be re-implemented outside it.
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
  // Done once at render time; the viewer no longer post-processes links.
  hardenSvgLinks(svg);
  return new Blob([new XMLSerializer().serializeToString(svg)], {
    type: PUBLISHED_ARTIFACT_MIME_TYPE,
  });
}

export async function renderPublishedArtifacts(
  input: RenderPublishedArtifactsInput,
  options: { encodeImage?: ArtifactImageEncoder } = {},
): Promise<RenderedPublishedArtifacts> {
  // `exportToSvg` renders exactly the elements it is given; tombstones from
  // the collaboration-aware snapshot must be dropped here.
  const elements = input.elements.filter(isNotDeleted);
  // Both variants embed the same bytes, so the images are optimised once.
  const files = await optimizeArtifactFiles(input.files, options.encodeImage);
  const [light, dark] = await Promise.all([
    renderVariant(input, elements, files, false),
    renderVariant(input, elements, files, true),
  ]);
  return { light, dark, engineVersion: EXCALIDRAW_ENGINE_VERSION };
}
