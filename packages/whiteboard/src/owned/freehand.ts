import { getStroke } from "perfect-freehand";
import type { WhiteboardElement } from "../contracts";
import { readElementNumber } from "./geometry";

export type FreeDrawOutlinePoint = readonly [number, number];

export function createFreeDrawOutline(
  element: WhiteboardElement,
): readonly FreeDrawOutlinePoint[] {
  if (element.type !== "freedraw") return [];
  const input = element.points.length
    ? element.points.map(([x, y]) => [x, y])
    : [[0, 0]];
  return getStroke(input, {
    easing: (pressure) => Math.sin((pressure * Math.PI) / 2),
    last: true,
    simulatePressure: true,
    size: readElementNumber(element, "strokeWidth", 1) * 4.25,
    smoothing: 0.5,
    streamline: 0.5,
    thinning: 0.6,
  }).map((point) => [point[0] ?? 0, point[1] ?? 0] as const);
}

export function traceFreeDrawOutline(
  context: CanvasRenderingContext2D,
  outline: readonly FreeDrawOutlinePoint[],
): void {
  const first = outline[0];
  if (!first) return;
  context.beginPath();
  context.moveTo(first[0], first[1]);
  for (let index = 1; index < outline.length; index += 1) {
    const point = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    context.quadraticCurveTo(
      point[0],
      point[1],
      (point[0] + next[0]) / 2,
      (point[1] + next[1]) / 2,
    );
  }
  context.closePath();
}

export function getFreeDrawSvgPath(
  outline: readonly FreeDrawOutlinePoint[],
): string {
  const first = outline[0];
  if (!first) return "";
  const parts = ["M", formatPoint(first), "Q"];
  for (let index = 1; index < outline.length; index += 1) {
    const point = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    parts.push(
      formatPoint(point),
      formatPoint([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]),
    );
  }
  parts.push("Z");
  return parts.join(" ");
}

function formatPoint(point: FreeDrawOutlinePoint): string {
  return `${formatNumber(point[0])},${formatNumber(point[1])}`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}
