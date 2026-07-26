import type { WhiteboardElement } from "@/features/whiteboard/contracts";
import {
  getElementGeometry,
  unionBounds,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";

export const OWNED_MIN_ELEMENT_SIZE = 1;
export const OWNED_ROTATION_HANDLE_OFFSET = 24;

export type OwnedResizeHandle =
  "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export type OwnedTransformHandle = OwnedResizeHandle | "rotate";

export function getSelectionBounds(
  elements: readonly WhiteboardElement[],
): WhiteboardBounds | null {
  return unionBounds(
    elements.flatMap((element) => {
      const geometry = getElementGeometry(element);
      return geometry ? [geometry.bounds] : [];
    }),
  );
}

export function translateElements(
  elements: readonly WhiteboardElement[],
  delta: WhiteboardPoint,
): readonly WhiteboardElement[] {
  const deltaX = finiteNumber(delta.x, 0);
  const deltaY = finiteNumber(delta.y, 0);
  return elements.map((element) => ({
    ...element,
    x: finiteNumber(element.x, 0) + deltaX,
    y: finiteNumber(element.y, 0) + deltaY,
  }));
}

export function resizeElements(
  elements: readonly WhiteboardElement[],
  source: WhiteboardBounds,
  target: WhiteboardBounds,
): readonly WhiteboardElement[] {
  const safeSource = finiteBounds(source);
  const safeTarget = finiteBounds(target);
  const sourceWidth = safeSource.maxX - safeSource.minX;
  const sourceHeight = safeSource.maxY - safeSource.minY;
  const targetWidth = safeTarget.maxX - safeTarget.minX;
  const targetHeight = safeTarget.maxY - safeTarget.minY;
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;

  return elements.map((element) => {
    const x = finiteNumber(element.x, safeSource.minX);
    const y = finiteNumber(element.y, safeSource.minY);
    const width = Math.max(0, finiteNumber(element.width, 0));
    const height = Math.max(0, finiteNumber(element.height, 0));
    const points = element.points?.map(
      ([pointX, pointY]) =>
        [
          finiteNumber(pointX, 0) * scaleX,
          finiteNumber(pointY, 0) * scaleY,
        ] as const,
    );
    const fontSize =
      element.type === "text" && element.fontSize !== undefined
        ? Math.max(
            OWNED_MIN_ELEMENT_SIZE,
            finiteNumber(element.fontSize, 20) * scaleY,
          )
        : element.fontSize;
    return {
      ...element,
      x: safeTarget.minX + (x - safeSource.minX) * scaleX,
      y: safeTarget.minY + (y - safeSource.minY) * scaleY,
      width: width * scaleX,
      height: height * scaleY,
      ...(points ? { points } : {}),
      ...(fontSize === undefined ? {} : { fontSize }),
    };
  });
}

export function resizeElementsUniformly(
  elements: readonly WhiteboardElement[],
  source: WhiteboardBounds,
  target: WhiteboardBounds,
  handle: OwnedResizeHandle,
): readonly WhiteboardElement[] {
  const safeSource = finiteBounds(source);
  const safeTarget = finiteBounds(target);
  const scale =
    handle === "n" || handle === "s"
      ? (safeTarget.maxY - safeTarget.minY) /
        (safeSource.maxY - safeSource.minY)
      : (safeTarget.maxX - safeTarget.minX) /
        (safeSource.maxX - safeSource.minX);
  const anchor = {
    x: handle.includes("w")
      ? safeSource.maxX
      : handle.includes("e")
        ? safeSource.minX
        : (safeSource.minX + safeSource.maxX) / 2,
    y: handle.includes("n")
      ? safeSource.maxY
      : handle.includes("s")
        ? safeSource.minY
        : (safeSource.minY + safeSource.maxY) / 2,
  };
  return elements.map((element) => {
    const width = Math.max(0, finiteNumber(element.width, 0));
    const height = Math.max(0, finiteNumber(element.height, 0));
    const center = {
      x: finiteNumber(element.x, 0) + width / 2,
      y: finiteNumber(element.y, 0) + height / 2,
    };
    const nextWidth = width * scale;
    const nextHeight = height * scale;
    const nextCenter = {
      x: anchor.x + (center.x - anchor.x) * scale,
      y: anchor.y + (center.y - anchor.y) * scale,
    };
    const points = element.points?.map(
      ([pointX, pointY]) =>
        [
          finiteNumber(pointX, 0) * scale,
          finiteNumber(pointY, 0) * scale,
        ] as const,
    );
    const fontSize =
      element.type === "text" && element.fontSize !== undefined
        ? Math.max(
            OWNED_MIN_ELEMENT_SIZE,
            finiteNumber(element.fontSize, 20) * scale,
          )
        : element.fontSize;
    return {
      ...element,
      x: nextCenter.x - nextWidth / 2,
      y: nextCenter.y - nextHeight / 2,
      width: nextWidth,
      height: nextHeight,
      ...(points ? { points } : {}),
      ...(fontSize === undefined ? {} : { fontSize }),
    };
  });
}

export function rotateElements(
  elements: readonly WhiteboardElement[],
  center: WhiteboardPoint,
  angleDelta: number,
): readonly WhiteboardElement[] {
  const safeDelta = finiteNumber(angleDelta, 0);
  const safeCenter = {
    x: finiteNumber(center.x, 0),
    y: finiteNumber(center.y, 0),
  };
  return elements.map((element) => {
    const width = Math.max(0, finiteNumber(element.width, 0));
    const height = Math.max(0, finiteNumber(element.height, 0));
    const elementCenter = {
      x: finiteNumber(element.x, 0) + width / 2,
      y: finiteNumber(element.y, 0) + height / 2,
    };
    const rotatedCenter = rotatePoint(elementCenter, safeCenter, safeDelta);
    return {
      ...element,
      x: rotatedCenter.x - width / 2,
      y: rotatedCenter.y - height / 2,
      width,
      height,
      angle: normalizeAngle(finiteNumber(element.angle, 0) + safeDelta),
    };
  });
}

export function getResizedBounds(
  source: WhiteboardBounds,
  handle: OwnedResizeHandle,
  pointer: WhiteboardPoint,
  preserveAspectRatio: boolean,
): WhiteboardBounds {
  const safeSource = finiteBounds(source);
  const safePointer = {
    x: finiteNumber(pointer.x, (safeSource.minX + safeSource.maxX) / 2),
    y: finiteNumber(pointer.y, (safeSource.minY + safeSource.maxY) / 2),
  };
  let minX = safeSource.minX;
  let minY = safeSource.minY;
  let maxX = safeSource.maxX;
  let maxY = safeSource.maxY;
  if (handle.includes("w")) minX = Math.min(safePointer.x, maxX - 1);
  if (handle.includes("e")) maxX = Math.max(safePointer.x, minX + 1);
  if (handle.includes("n")) minY = Math.min(safePointer.y, maxY - 1);
  if (handle.includes("s")) maxY = Math.max(safePointer.y, minY + 1);
  if (!preserveAspectRatio) return { minX, minY, maxX, maxY };

  const sourceWidth = safeSource.maxX - safeSource.minX;
  const sourceHeight = safeSource.maxY - safeSource.minY;
  const aspect = sourceWidth / sourceHeight;
  const horizontal = handle === "e" || handle === "w";
  const vertical = handle === "n" || handle === "s";

  if (horizontal) {
    const height = (maxX - minX) / aspect;
    const centerY = (safeSource.minY + safeSource.maxY) / 2;
    minY = centerY - height / 2;
    maxY = centerY + height / 2;
  } else if (vertical) {
    const width = (maxY - minY) * aspect;
    const centerX = (safeSource.minX + safeSource.maxX) / 2;
    minX = centerX - width / 2;
    maxX = centerX + width / 2;
  } else {
    const width = maxX - minX;
    const height = maxY - minY;
    if (width / sourceWidth >= height / sourceHeight) {
      const nextHeight = width / aspect;
      if (handle.includes("n")) minY = maxY - nextHeight;
      else maxY = minY + nextHeight;
    } else {
      const nextWidth = height * aspect;
      if (handle.includes("w")) minX = maxX - nextWidth;
      else maxX = minX + nextWidth;
    }
  }
  return { minX, minY, maxX, maxY };
}

export function getTransformHandleAt(
  point: WhiteboardPoint,
  bounds: WhiteboardBounds,
  zoom: number,
): OwnedTransformHandle | null {
  const usableZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const tolerance = 5 / usableZoom;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const candidates: readonly [OwnedTransformHandle, WhiteboardPoint][] = [
    [
      "rotate",
      {
        x: centerX,
        y: bounds.minY - OWNED_ROTATION_HANDLE_OFFSET / usableZoom,
      },
    ],
    ["nw", { x: bounds.minX, y: bounds.minY }],
    ["n", { x: centerX, y: bounds.minY }],
    ["ne", { x: bounds.maxX, y: bounds.minY }],
    ["e", { x: bounds.maxX, y: centerY }],
    ["se", { x: bounds.maxX, y: bounds.maxY }],
    ["s", { x: centerX, y: bounds.maxY }],
    ["sw", { x: bounds.minX, y: bounds.maxY }],
    ["w", { x: bounds.minX, y: centerY }],
  ];
  return (
    candidates.find(
      ([, candidate]) =>
        Math.hypot(point.x - candidate.x, point.y - candidate.y) <= tolerance,
    )?.[0] ?? null
  );
}

export function selectionCenter(bounds: WhiteboardBounds): WhiteboardPoint {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
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

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function finiteBounds(bounds: WhiteboardBounds): WhiteboardBounds {
  const minX = finiteNumber(bounds.minX, 0);
  const minY = finiteNumber(bounds.minY, 0);
  return {
    minX,
    minY,
    maxX: Math.max(
      minX + OWNED_MIN_ELEMENT_SIZE,
      finiteNumber(bounds.maxX, minX + OWNED_MIN_ELEMENT_SIZE),
    ),
    maxY: Math.max(
      minY + OWNED_MIN_ELEMENT_SIZE,
      finiteNumber(bounds.maxY, minY + OWNED_MIN_ELEMENT_SIZE),
    ),
  };
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
