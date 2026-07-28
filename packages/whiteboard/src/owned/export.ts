import rough from "roughjs/bin/rough";
import type { RoughGenerator } from "roughjs/bin/generator";
import type {
  OwnedWhiteboardDocument,
  WhiteboardElement,
  WhiteboardImageExportOptions,
} from "../contracts";
import {
  getDocumentBounds,
  getElementGeometry,
  isElementVisible,
  readElementNumber,
  readElementPoints,
  readElementString,
} from "./geometry";
import { isSafeInlineImage, pruneUnreferencedWhiteboardAssets } from "./assets";
import { createFreeDrawOutline, getFreeDrawSvgPath } from "./freehand";
import {
  createPersistedWhiteboardDocumentV3,
  serializeWhiteboardDocumentV3,
} from "../v3-document";
import {
  OWNED_DARK_THEME_FILTER,
  applyOwnedDarkModeFilter,
} from "./theme-color";
import {
  createRoughDrawables,
  isRoughRenderableElement,
  lineDashFor,
} from "./rough-shapes";

const DEFAULT_EXPORT_PADDING = 10;
const MIN_EXPORT_SCALE = 0.1;
const MAX_EXPORT_SCALE = 8;
const MAX_EXPORT_DIMENSION = 16_384;
const MAX_EXPORT_PIXELS = 67_108_864;

export async function exportOwnedWhiteboardImage(
  document: OwnedWhiteboardDocument,
  options: WhiteboardImageExportOptions,
  selectedElementIds: readonly string[] = [],
): Promise<Blob> {
  const svg = exportOwnedWhiteboardSvg(document, options, selectedElementIds);
  if (options.format === "svg") {
    return new Blob([svg], { type: "image/svg+xml" });
  }
  return await rasterizeSvg(svg, options);
}

export function exportOwnedWhiteboardDocument(
  document: OwnedWhiteboardDocument,
): Blob {
  const availableAssets = document.assets;
  const elements = document.elements.map((element) =>
    !element.isDeleted &&
    element.type === "image" &&
    typeof element.fileId === "string" &&
    !availableAssets[element.fileId]
      ? { ...element, fileId: null }
      : element,
  );
  return new Blob(
    [
      serializeWhiteboardDocumentV3(
        createPersistedWhiteboardDocumentV3({
          ...document,
          elements,
          assets: availableAssets,
        }),
      ),
    ],
    { type: "application/json" },
  );
}

export function exportOwnedWhiteboardSvg(
  document: OwnedWhiteboardDocument,
  options: WhiteboardImageExportOptions,
  selectedElementIds: readonly string[] = [],
): string {
  const selectedIds = new Set(selectedElementIds);
  const elements = document.elements.filter(
    (element) =>
      isElementVisible(element) &&
      (!options.selectionOnly || selectedIds.has(element.id)),
  );
  const bounds = getDocumentBounds(elements) ?? {
    minX: 0,
    minY: 0,
    maxX: 1,
    maxY: 1,
  };
  const padding = finiteNonNegative(
    options.exportPadding,
    DEFAULT_EXPORT_PADDING,
  );
  const width = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;
  const safeDocument = pruneUnreferencedWhiteboardAssets({
    ...document,
    elements,
  });
  const exportWithDarkMode =
    options.exportWithDarkMode ?? document.state.theme === "dark";
  const background =
    typeof document.state.viewBackgroundColor === "string"
      ? document.state.viewBackgroundColor
      : "#ffffff";
  const roughGenerator = rough.generator();
  const frameClipIds = new Map(
    document.elements
      .filter(
        (element) => element.type === "frame" && isElementVisible(element),
      )
      .map((frame, index) => [frame.id, `frame-clip-${index}`]),
  );
  const elementsById = new Map(
    document.elements.map((element) => [element.id, element]),
  );
  const clipDefinitions = [...frameClipIds].map(([frameId, clipId]) => {
    const frame = elementsById.get(frameId);
    return frame ? serializeFrameClip(frame, clipId, offsetX, offsetY) : "";
  });
  const body = elements
    .map((element) => {
      let serialized = serializeElement(
        element,
        safeDocument,
        offsetX,
        offsetY,
        exportWithDarkMode,
        roughGenerator,
      );
      const visited = new Set<string>();
      let frameId = element.frameId;
      while (frameId && !visited.has(frameId)) {
        visited.add(frameId);
        const clipId = frameClipIds.get(frameId);
        if (clipId) {
          serialized = `<g clip-path="url(#${clipId})">${serialized}</g>`;
        }
        frameId = elementsById.get(frameId)?.frameId ?? null;
      }
      return serialized;
    })
    .join("");

  return [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` width="${formatNumber(width)}" height="${formatNumber(height)}"`,
    ` viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}"`,
    ' role="img">',
    clipDefinitions.length > 0
      ? `<defs>${clipDefinitions.join("")}</defs>`
      : "",
    options.background === false
      ? ""
      : `<rect width="100%" height="100%" fill="${escapeAttribute(applyOwnedDarkModeFilter(background, exportWithDarkMode))}"/>`,
    body,
    "</svg>",
  ].join("");
}

function serializeFrameClip(
  frame: WhiteboardElement,
  clipId: string,
  offsetX: number,
  offsetY: number,
): string {
  const geometry = getElementGeometry(frame);
  if (!geometry) return "";
  const centerX = geometry.x + geometry.width / 2 + offsetX;
  const centerY = geometry.y + geometry.height / 2 + offsetY;
  const rotation = (geometry.angle * 180) / Math.PI;
  return [
    `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">`,
    `<rect x="${formatNumber(geometry.x + offsetX)}"`,
    ` y="${formatNumber(geometry.y + offsetY)}"`,
    ` width="${formatNumber(geometry.width)}"`,
    ` height="${formatNumber(geometry.height)}"`,
    ` transform="rotate(${formatNumber(rotation)} ${formatNumber(centerX)} ${formatNumber(centerY)})"/>`,
    "</clipPath>",
  ].join("");
}

function serializeElement(
  element: WhiteboardElement,
  document: OwnedWhiteboardDocument,
  offsetX: number,
  offsetY: number,
  exportWithDarkMode: boolean,
  roughGenerator: RoughGenerator,
): string {
  const geometry = getElementGeometry(element);
  if (!geometry) return "";
  const opacity = clamp(readElementNumber(element, "opacity", 100) / 100, 0, 1);
  const stroke = escapeAttribute(
    applyOwnedDarkModeFilter(
      readElementString(element, "strokeColor", "#1e1e1e"),
      exportWithDarkMode,
    ),
  );
  const fill = escapeAttribute(
    applyOwnedDarkModeFilter(
      readElementString(element, "backgroundColor", "transparent"),
      exportWithDarkMode,
    ),
  );
  const strokeWidth = Math.max(
    0.5,
    readElementNumber(element, "strokeWidth", 1),
  );
  const dash = strokeDashArray(element);
  const centerX = geometry.x + geometry.width / 2 + offsetX;
  const centerY = geometry.y + geometry.height / 2 + offsetY;
  const transform = `translate(${formatNumber(centerX)} ${formatNumber(centerY)}) rotate(${formatNumber((geometry.angle * 180) / Math.PI)}) translate(${formatNumber(-geometry.width / 2)} ${formatNumber(-geometry.height / 2)})`;
  const commonAttributes = [
    `opacity="${formatNumber(opacity)}"`,
    `transform="${transform}"`,
  ]
    .filter(Boolean)
    .join(" ");
  const attributes = [
    commonAttributes,
    `stroke="${stroke}"`,
    `stroke-width="${formatNumber(strokeWidth)}"`,
    `stroke-linecap="round"`,
    `stroke-linejoin="round"`,
    dash ? `stroke-dasharray="${dash}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (element.type === "text") {
    const fontSize = Math.max(1, readElementNumber(element, "fontSize", 20));
    const lineHeight = Math.max(
      0.5,
      readElementNumber(element, "lineHeight", 1.25),
    );
    const text = readElementString(element, "text", "");
    const spans = text
      .split("\n")
      .map(
        (line, index) =>
          `<tspan x="0" y="${formatNumber(index * fontSize * lineHeight)}">${escapeText(line)}</tspan>`,
      )
      .join("");
    return `<text ${commonAttributes} fill="${stroke}" stroke="none" font-family="sans-serif" font-size="${formatNumber(fontSize)}" dominant-baseline="text-before-edge">${spans}</text>`;
  }

  if (element.type === "image") {
    const asset =
      typeof element.fileId === "string"
        ? document.assets[element.fileId]
        : undefined;
    if (asset && isSafeInlineImage(asset)) {
      const filter =
        exportWithDarkMode && asset.mimeType === "image/svg+xml"
          ? ` filter="${OWNED_DARK_THEME_FILTER}"`
          : "";
      return `<image ${attributes}${filter} x="0" y="0" width="${formatNumber(geometry.width)}" height="${formatNumber(geometry.height)}" href="${escapeAttribute(asset.dataURL)}" preserveAspectRatio="none"/>`;
    }
    return serializeMissingAsset(
      attributes,
      geometry.width,
      geometry.height,
      exportWithDarkMode,
    );
  }

  if (isRoughRenderableElement(element)) {
    const paths = createRoughDrawables(
      roughGenerator,
      element,
      geometry.width,
      geometry.height,
      exportWithDarkMode ? "dark" : "light",
    ).flatMap((drawable) => roughGenerator.toPaths(drawable));
    const dash = lineDashFor(element).join(" ");
    const serializedPaths = paths
      .map((path) => {
        const isStrokePath = path.stroke !== "none" && path.fill === "none";
        return [
          `<path d="${escapeAttribute(path.d)}"`,
          ` stroke="${escapeAttribute(path.stroke)}"`,
          ` stroke-width="${formatNumber(path.strokeWidth)}"`,
          ` fill="${escapeAttribute(path.fill ?? "none")}"`,
          dash && isStrokePath ? ` stroke-dasharray="${dash}"` : "",
          "/>",
        ].join("");
      })
      .join("");
    return `<g ${commonAttributes} stroke-linecap="round" stroke-linejoin="round">${serializedPaths}</g>`;
  }

  if (element.type === "freedraw") {
    const path = getFreeDrawSvgPath(createFreeDrawOutline(element));
    return path
      ? `<path ${commonAttributes} d="${escapeAttribute(path)}" fill="${stroke}" stroke="none"/>`
      : "";
  }

  if (element.type === "line" || element.type === "arrow") {
    const points = readElementPoints(element);
    if (points.length === 0) return "";
    const path = points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${formatNumber(point.x)} ${formatNumber(point.y)}`,
      )
      .join(" ");
    const arrow =
      element.type === "arrow" && points.length > 1
        ? serializeArrowHead(points, strokeWidth)
        : "";
    return `<g ${attributes} fill="none"><path d="${path}"/>${arrow}</g>`;
  }

  if (element.type === "ellipse") {
    return `<ellipse ${attributes} cx="${formatNumber(geometry.width / 2)}" cy="${formatNumber(geometry.height / 2)}" rx="${formatNumber(Math.abs(geometry.width / 2))}" ry="${formatNumber(Math.abs(geometry.height / 2))}" fill="${fill}"/>`;
  }
  if (element.type === "diamond") {
    const points = [
      `${formatNumber(geometry.width / 2)},0`,
      `${formatNumber(geometry.width)},${formatNumber(geometry.height / 2)}`,
      `${formatNumber(geometry.width / 2)},${formatNumber(geometry.height)}`,
      `0,${formatNumber(geometry.height / 2)}`,
    ].join(" ");
    return `<polygon ${attributes} points="${points}" fill="${fill}"/>`;
  }
  return `<rect ${attributes} x="0" y="0" width="${formatNumber(geometry.width)}" height="${formatNumber(geometry.height)}" fill="${fill}"/>`;
}

function serializeArrowHead(
  points: readonly { readonly x: number; readonly y: number }[],
  strokeWidth: number,
): string {
  const end = points.at(-1)!;
  const previous = points.at(-2)!;
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  const size = Math.max(8, strokeWidth * 4);
  const first = {
    x: end.x - Math.cos(angle - Math.PI / 6) * size,
    y: end.y - Math.sin(angle - Math.PI / 6) * size,
  };
  const second = {
    x: end.x - Math.cos(angle + Math.PI / 6) * size,
    y: end.y - Math.sin(angle + Math.PI / 6) * size,
  };
  return `<path d="M${formatNumber(first.x)} ${formatNumber(first.y)} L${formatNumber(end.x)} ${formatNumber(end.y)} L${formatNumber(second.x)} ${formatNumber(second.y)}"/>`;
}

function serializeMissingAsset(
  attributes: string,
  width: number,
  height: number,
  exportWithDarkMode: boolean,
): string {
  const safeWidth = formatNumber(width);
  const safeHeight = formatNumber(height);
  const fill = applyOwnedDarkModeFilter("#f1f3f5", exportWithDarkMode);
  const stroke = applyOwnedDarkModeFilter("#868e96", exportWithDarkMode);
  return `<g ${attributes} data-missing-asset="true"><rect width="${safeWidth}" height="${safeHeight}" fill="${fill}" stroke="${stroke}"/><path d="M0 0 L${safeWidth} ${safeHeight} M${safeWidth} 0 L0 ${safeHeight}" stroke="${stroke}"/></g>`;
}

async function rasterizeSvg(
  svg: string,
  options: WhiteboardImageExportOptions,
): Promise<Blob> {
  const dimensions = readSvgDimensions(svg);
  const requestedScale = clamp(
    finitePositive(options.scale, 1),
    MIN_EXPORT_SCALE,
    MAX_EXPORT_SCALE,
  );
  const maximumDimension = Math.max(dimensions.width, dimensions.height);
  const cappedScale =
    typeof options.maxWidthOrHeight === "number" &&
    Number.isFinite(options.maxWidthOrHeight) &&
    options.maxWidthOrHeight > 0
      ? Math.min(requestedScale, options.maxWidthOrHeight / maximumDimension)
      : requestedScale;
  const safeScale = Math.min(
    cappedScale,
    MAX_EXPORT_DIMENSION / dimensions.width,
    MAX_EXPORT_DIMENSION / dimensions.height,
    Math.sqrt(MAX_EXPORT_PIXELS / (dimensions.width * dimensions.height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(dimensions.width * safeScale));
  canvas.height = Math.max(1, Math.round(dimensions.height * safeScale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG export requires 2D canvas support");

  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = await loadImage(url);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  return await canvasToPngBlob(canvas, options.quality);
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render the SVG export"));
    image.src = source;
  });
}

function canvasToPngBlob(
  canvas: HTMLCanvasElement,
  quality: number | undefined,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not encode the PNG export")),
      "image/png",
      quality,
    );
  });
}

function readSvgDimensions(svg: string): {
  readonly width: number;
  readonly height: number;
} {
  const match = /<svg[^>]*\swidth="([^"]+)"\sheight="([^"]+)"/.exec(svg);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("SVG export dimensions are invalid");
  }
  return { width, height };
}

function strokeDashArray(element: WhiteboardElement): string {
  return lineDashFor(element).join(" ");
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function finiteNonNegative(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}
