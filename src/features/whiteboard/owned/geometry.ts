import type {
  WhiteboardElement,
  WhiteboardViewport,
} from "@/features/whiteboard/contracts";

export interface WhiteboardPoint {
  readonly x: number;
  readonly y: number;
}

export interface WhiteboardBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface ElementGeometry {
  readonly element: WhiteboardElement;
  readonly bounds: WhiteboardBounds;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly points: readonly WhiteboardPoint[];
}

const SUPPORTED_ELEMENT_TYPES = new Set([
  "arrow",
  "diamond",
  "ellipse",
  "embeddable",
  "frame",
  "freedraw",
  "iframe",
  "image",
  "line",
  "magicframe",
  "rectangle",
  "text",
]);

const LINEAR_ELEMENT_TYPES = new Set(["arrow", "freedraw", "line"]);

export function screenToDocument(
  point: WhiteboardPoint,
  viewport: WhiteboardViewport,
): WhiteboardPoint {
  const zoom = usableZoom(viewport.zoom);
  return {
    x: (point.x - viewport.offsetX) / zoom - viewport.x,
    y: (point.y - viewport.offsetY) / zoom - viewport.y,
  };
}

export function documentToScreen(
  point: WhiteboardPoint,
  viewport: WhiteboardViewport,
): WhiteboardPoint {
  const zoom = usableZoom(viewport.zoom);
  return {
    x: viewport.offsetX + (point.x + viewport.x) * zoom,
    y: viewport.offsetY + (point.y + viewport.y) * zoom,
  };
}

export function zoomViewportAt(
  viewport: WhiteboardViewport,
  zoom: number,
  anchor: WhiteboardPoint,
): Pick<WhiteboardViewport, "x" | "y" | "zoom"> {
  const nextZoom = usableZoom(zoom);
  const documentAnchor = screenToDocument(anchor, viewport);
  return {
    x: (anchor.x - viewport.offsetX) / nextZoom - documentAnchor.x,
    y: (anchor.y - viewport.offsetY) / nextZoom - documentAnchor.y,
    zoom: nextZoom,
  };
}

export function boundsFromPoints(
  points: readonly WhiteboardPoint[],
): WhiteboardBounds | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(
  bounds: readonly WhiteboardBounds[],
): WhiteboardBounds | null {
  if (bounds.length === 0) return null;
  return {
    minX: Math.min(...bounds.map((item) => item.minX)),
    minY: Math.min(...bounds.map((item) => item.minY)),
    maxX: Math.max(...bounds.map((item) => item.maxX)),
    maxY: Math.max(...bounds.map((item) => item.maxY)),
  };
}

export function normalizeBounds(
  first: WhiteboardPoint,
  second: WhiteboardPoint,
): WhiteboardBounds {
  return {
    minX: Math.min(first.x, second.x),
    minY: Math.min(first.y, second.y),
    maxX: Math.max(first.x, second.x),
    maxY: Math.max(first.y, second.y),
  };
}

export function boundsIntersect(
  left: WhiteboardBounds,
  right: WhiteboardBounds,
): boolean {
  return (
    left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY
  );
}

export function getElementGeometry(
  element: WhiteboardElement,
): ElementGeometry | null {
  if (!isSupportedElement(element)) return null;
  const x = finiteNumber(element.x, 0);
  const y = finiteNumber(element.y, 0);
  const width = finiteNumber(element.width, 0);
  const height = finiteNumber(element.height, 0);
  const angle = finiteNumber(element.angle, 0);
  const points =
    element.type === "arrow" ||
    element.type === "freedraw" ||
    element.type === "line"
      ? readPoints(element.points).map((point) => ({
          x: point.x + x,
          y: point.y + y,
        }))
      : [];

  const unrotated =
    points.length > 0
      ? boundsFromPoints(points)
      : normalizeBounds({ x, y }, { x: x + width, y: y + height });
  if (!unrotated) return null;

  const center = {
    x: x + width / 2,
    y: y + height / 2,
  };
  const bounds =
    angle === 0
      ? unrotated
      : boundsFromPoints(
          boundsCorners(unrotated).map((point) =>
            rotatePoint(point, center, angle),
          ),
        );
  if (!bounds) return null;

  return { element, bounds, x, y, width, height, angle, points };
}

export function getDocumentBounds(
  elements: readonly WhiteboardElement[],
): WhiteboardBounds | null {
  return unionBounds(
    elements.filter(isElementVisible).flatMap((element) => {
      const geometry = getElementGeometry(element);
      return geometry ? [geometry.bounds] : [];
    }),
  );
}

export function hitTestElements(
  elements: readonly WhiteboardElement[],
  point: WhiteboardPoint,
  zoom = 1,
): WhiteboardElement | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (!element || !isElementSelectable(element)) continue;
    const geometry = getElementGeometry(element);
    if (geometry && hitTestGeometry(geometry, point, zoom)) return element;
  }
  return null;
}

export function elementsInBounds(
  elements: readonly WhiteboardElement[],
  bounds: WhiteboardBounds,
): readonly WhiteboardElement[] {
  return elements.filter((element) => {
    if (!isElementSelectable(element)) return false;
    const geometry = getElementGeometry(element);
    return geometry ? boundsIntersect(geometry.bounds, bounds) : false;
  });
}

export function isElementVisible(element: WhiteboardElement): boolean {
  if (element.isDeleted || !SUPPORTED_ELEMENT_TYPES.has(element.type)) {
    return false;
  }
  return element.opacity > 0;
}

export function isElementSelectable(element: WhiteboardElement): boolean {
  if (element.isDeleted || !SUPPORTED_ELEMENT_TYPES.has(element.type)) {
    return false;
  }
  return !element.locked;
}

export function readElementNumber(
  element: WhiteboardElement,
  key: string,
  fallback: number,
): number {
  if (key === "opacity") return element.opacity;
  if (key === "strokeWidth") return element.strokeWidth;
  if (key === "fontSize" && element.type === "text") return element.fontSize;
  if (key === "lineHeight" && element.type === "text") {
    return element.lineHeight;
  }
  return fallback;
}

export function readElementString(
  element: WhiteboardElement,
  key: string,
  fallback: string,
): string {
  if (key === "strokeColor") return element.strokeColor;
  if (key === "backgroundColor") return element.backgroundColor;
  if (key === "strokeStyle") return element.strokeStyle;
  if (key === "text" && element.type === "text") return element.text;
  return fallback;
}

export function readElementPoints(
  element: WhiteboardElement,
): readonly WhiteboardPoint[] {
  return element.type === "arrow" ||
    element.type === "freedraw" ||
    element.type === "line"
    ? readPoints(element.points)
    : [];
}

function hitTestGeometry(
  geometry: ElementGeometry,
  point: WhiteboardPoint,
  zoom: number,
): boolean {
  const localPoint =
    geometry.angle === 0
      ? point
      : rotatePoint(
          point,
          {
            x: geometry.x + geometry.width / 2,
            y: geometry.y + geometry.height / 2,
          },
          -geometry.angle,
        );
  const { element } = geometry;
  if (LINEAR_ELEMENT_TYPES.has(element.type)) {
    const tolerance = Math.max(
      6 / usableZoom(zoom),
      readElementNumber(element, "strokeWidth", 1) / 2,
    );
    return geometry.points.some((segmentStart, index) => {
      const segmentEnd = geometry.points[index + 1];
      return (
        segmentEnd !== undefined &&
        distanceToSegment(localPoint, segmentStart, segmentEnd) <= tolerance
      );
    });
  }

  const left = Math.min(geometry.x, geometry.x + geometry.width);
  const right = Math.max(geometry.x, geometry.x + geometry.width);
  const top = Math.min(geometry.y, geometry.y + geometry.height);
  const bottom = Math.max(geometry.y, geometry.y + geometry.height);
  if (
    localPoint.x < left ||
    localPoint.x > right ||
    localPoint.y < top ||
    localPoint.y > bottom
  ) {
    return false;
  }

  const halfWidth = Math.abs(geometry.width) / 2;
  const halfHeight = Math.abs(geometry.height) / 2;
  if (halfWidth === 0 || halfHeight === 0) return true;
  const centerX = left + halfWidth;
  const centerY = top + halfHeight;
  const normalizedX = Math.abs(localPoint.x - centerX) / halfWidth;
  const normalizedY = Math.abs(localPoint.y - centerY) / halfHeight;
  if (element.type === "ellipse") {
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  }
  if (element.type === "diamond") {
    return normalizedX + normalizedY <= 1;
  }
  return true;
}

function distanceToSegment(
  point: WhiteboardPoint,
  start: WhiteboardPoint,
  end: WhiteboardPoint,
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0)
    return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + projection * deltaX),
    point.y - (start.y + projection * deltaY),
  );
}

function boundsCorners(bounds: WhiteboardBounds): readonly WhiteboardPoint[] {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
}

function rotatePoint(
  point: WhiteboardPoint,
  center: WhiteboardPoint,
  angle: number,
): WhiteboardPoint {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const deltaX = point.x - center.x;
  const deltaY = point.y - center.y;
  return {
    x: center.x + deltaX * cosine - deltaY * sine,
    y: center.y + deltaX * sine + deltaY * cosine,
  };
}

function readPoints(value: unknown): readonly WhiteboardPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate: unknown) => {
    const point = candidate;
    if (!Array.isArray(point)) return [];
    const values = point as readonly unknown[];
    const x = values[0];
    const y = values[1];
    return typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y)
      ? [{ x, y }]
      : [];
  });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function usableZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function isSupportedElement(element: WhiteboardElement): boolean {
  return SUPPORTED_ELEMENT_TYPES.has(element.type);
}
