import type { WhiteboardElement } from "../contracts";
import {
  getElementGeometry,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";

export type OwnedSnapAxis = "x" | "y";

export interface OwnedSnapGuide {
  readonly axis: OwnedSnapAxis;
  readonly position: number;
  readonly from: number;
  readonly to: number;
  readonly distance: number;
}

export interface OwnedMoveSnapResult {
  readonly delta: WhiteboardPoint;
  readonly guides: readonly OwnedSnapGuide[];
}

export interface OwnedResizeSnapResult {
  readonly point: WhiteboardPoint;
  readonly guides: readonly OwnedSnapGuide[];
}

export function snapMoveDelta(options: {
  readonly selectionBounds: WhiteboardBounds;
  readonly candidates: readonly WhiteboardElement[];
  readonly delta: WhiteboardPoint;
  readonly zoom: number;
  readonly pointerType: "mouse" | "pen" | "touch";
  readonly gridSize?: number | null;
  readonly disabled?: boolean;
  readonly constrainAxis?: boolean;
}): OwnedMoveSnapResult {
  let delta = constrainMoveAxis(options.delta, options.constrainAxis === true);
  if (options.disabled) return { delta, guides: [] };
  const threshold =
    (options.pointerType === "touch" ? 8 : 5) / Math.max(0.05, options.zoom);
  const moved = translateBounds(options.selectionBounds, delta);
  const xLines = axisLines(moved.minX, moved.maxX);
  const yLines = axisLines(moved.minY, moved.maxY);
  const candidateBounds = options.candidates.flatMap((element) => {
    const geometry = getElementGeometry(element);
    return geometry ? [geometry.bounds] : [];
  });
  const candidateX = candidateBounds.flatMap((bounds) =>
    axisLines(bounds.minX, bounds.maxX),
  );
  const candidateY = candidateBounds.flatMap((bounds) =>
    axisLines(bounds.minY, bounds.maxY),
  );
  if (options.gridSize && options.gridSize > 0) {
    candidateX.push(...nearestGridLines(xLines, options.gridSize));
    candidateY.push(...nearestGridLines(yLines, options.gridSize));
  }
  const xSnap = closestLine(xLines, candidateX, threshold);
  const ySnap = closestLine(yLines, candidateY, threshold);
  const guides: OwnedSnapGuide[] = [];
  if (xSnap) {
    delta = { ...delta, x: delta.x + xSnap.offset };
    guides.push({
      axis: "x",
      position: xSnap.target,
      from: Math.min(
        moved.minY,
        ...candidateBounds.map((bounds) => bounds.minY),
      ),
      to: Math.max(moved.maxY, ...candidateBounds.map((bounds) => bounds.maxY)),
      distance: Math.abs(xSnap.offset),
    });
  }
  if (ySnap) {
    delta = { ...delta, y: delta.y + ySnap.offset };
    guides.push({
      axis: "y",
      position: ySnap.target,
      from: Math.min(
        moved.minX,
        ...candidateBounds.map((bounds) => bounds.minX),
      ),
      to: Math.max(moved.maxX, ...candidateBounds.map((bounds) => bounds.maxX)),
      distance: Math.abs(ySnap.offset),
    });
  }
  return { delta, guides };
}

export function snapRotation(angle: number, enabled: boolean): number {
  if (!enabled) return angle;
  const step = Math.PI / 12;
  return Math.round(angle / step) * step;
}

export function snapResizePoint(options: {
  readonly point: WhiteboardPoint;
  readonly candidates: readonly WhiteboardElement[];
  readonly zoom: number;
  readonly pointerType: "mouse" | "pen" | "touch";
  readonly gridSize?: number | null;
  readonly disabled?: boolean;
}): OwnedResizeSnapResult {
  if (options.disabled) return { point: options.point, guides: [] };
  const threshold =
    (options.pointerType === "touch" ? 8 : 5) / Math.max(0.05, options.zoom);
  const bounds = options.candidates.flatMap((element) => {
    const geometry = getElementGeometry(element);
    return geometry ? [geometry.bounds] : [];
  });
  const xTargets = bounds.flatMap((candidate) =>
    axisLines(candidate.minX, candidate.maxX),
  );
  const yTargets = bounds.flatMap((candidate) =>
    axisLines(candidate.minY, candidate.maxY),
  );
  if (options.gridSize && options.gridSize > 0) {
    xTargets.push(
      Math.round(options.point.x / options.gridSize) * options.gridSize,
    );
    yTargets.push(
      Math.round(options.point.y / options.gridSize) * options.gridSize,
    );
  }
  const xSnap = closestLine([options.point.x], xTargets, threshold);
  const ySnap = closestLine([options.point.y], yTargets, threshold);
  const point = {
    x: xSnap?.target ?? options.point.x,
    y: ySnap?.target ?? options.point.y,
  };
  const guides: OwnedSnapGuide[] = [];
  if (xSnap) {
    guides.push({
      axis: "x",
      position: xSnap.target,
      from: Math.min(options.point.y, ...bounds.map(({ minY }) => minY)),
      to: Math.max(options.point.y, ...bounds.map(({ maxY }) => maxY)),
      distance: Math.abs(xSnap.offset),
    });
  }
  if (ySnap) {
    guides.push({
      axis: "y",
      position: ySnap.target,
      from: Math.min(options.point.x, ...bounds.map(({ minX }) => minX)),
      to: Math.max(options.point.x, ...bounds.map(({ maxX }) => maxX)),
      distance: Math.abs(ySnap.offset),
    });
  }
  return { point, guides };
}

function constrainMoveAxis(
  delta: WhiteboardPoint,
  enabled: boolean,
): WhiteboardPoint {
  if (!enabled) return delta;
  return Math.abs(delta.x) >= Math.abs(delta.y)
    ? { x: delta.x, y: 0 }
    : { x: 0, y: delta.y };
}

function axisLines(min: number, max: number): number[] {
  return [min, (min + max) / 2, max];
}

function nearestGridLines(
  lines: readonly number[],
  gridSize: number,
): number[] {
  return lines.map((line) => Math.round(line / gridSize) * gridSize);
}

function closestLine(
  source: readonly number[],
  targets: readonly number[],
  threshold: number,
): { readonly offset: number; readonly target: number } | null {
  let best: { readonly offset: number; readonly target: number } | null = null;
  for (const line of source) {
    for (const target of targets) {
      const offset = target - line;
      if (
        Math.abs(offset) <= threshold &&
        (!best || Math.abs(offset) < Math.abs(best.offset))
      ) {
        best = { offset, target };
      }
    }
  }
  return best;
}

function translateBounds(
  bounds: WhiteboardBounds,
  delta: WhiteboardPoint,
): WhiteboardBounds {
  return {
    minX: bounds.minX + delta.x,
    minY: bounds.minY + delta.y,
    maxX: bounds.maxX + delta.x,
    maxY: bounds.maxY + delta.y,
  };
}
