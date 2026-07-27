import type { Drawable, Options } from "roughjs/bin/core";
import type { RoughGenerator } from "roughjs/bin/generator";
import type { WhiteboardElement, WhiteboardTheme } from "../contracts";
import { readElementNumber, readElementString } from "./geometry";
import { resolveOwnedThemeColor } from "./theme-color";

export function isRoughRenderableElement(element: WhiteboardElement): boolean {
  return (
    element.type === "rectangle" ||
    element.type === "diamond" ||
    element.type === "ellipse" ||
    element.type === "line" ||
    element.type === "arrow"
  );
}

export function createRoughDrawables(
  generator: RoughGenerator,
  element: WhiteboardElement,
  width: number,
  height: number,
  theme: WhiteboardTheme,
): readonly Drawable[] {
  const options = getRoughOptions(element, theme);
  if (element.type === "rectangle") {
    if (element.roundness === "round") {
      const radius = Math.min(Math.abs(width), Math.abs(height)) * 0.25;
      return [
        generator.path(
          [
            `M ${radius} 0`,
            `L ${width - radius} 0`,
            `Q ${width} 0, ${width} ${radius}`,
            `L ${width} ${height - radius}`,
            `Q ${width} ${height}, ${width - radius} ${height}`,
            `L ${radius} ${height}`,
            `Q 0 ${height}, 0 ${height - radius}`,
            `L 0 ${radius}`,
            `Q 0 0, ${radius} 0`,
          ].join(" "),
          options,
        ),
      ];
    }
    return [generator.rectangle(0, 0, width, height, options)];
  }
  if (element.type === "ellipse") {
    return [
      generator.ellipse(
        width / 2,
        height / 2,
        Math.abs(width),
        Math.abs(height),
        {
          ...options,
          curveFitting: 1,
        },
      ),
    ];
  }
  if (element.type === "diamond") {
    if (element.roundness === "round") {
      const topX = width / 2;
      const rightY = height / 2;
      const verticalRadius = Math.abs(width / 2) * 0.25;
      const horizontalRadius = Math.abs(height / 2) * 0.25;
      return [
        generator.path(
          [
            `M ${topX + verticalRadius} ${horizontalRadius}`,
            `L ${width - verticalRadius} ${rightY - horizontalRadius}`,
            `C ${width} ${rightY}, ${width} ${rightY}, ${width - verticalRadius} ${rightY + horizontalRadius}`,
            `L ${topX + verticalRadius} ${height - horizontalRadius}`,
            `C ${topX} ${height}, ${topX} ${height}, ${topX - verticalRadius} ${height - horizontalRadius}`,
            `L ${verticalRadius} ${rightY + horizontalRadius}`,
            `C 0 ${rightY}, 0 ${rightY}, ${verticalRadius} ${rightY - horizontalRadius}`,
            `L ${topX - verticalRadius} ${horizontalRadius}`,
            `C ${topX} 0, ${topX} 0, ${topX + verticalRadius} ${horizontalRadius}`,
          ].join(" "),
          options,
        ),
      ];
    }
    return [
      generator.polygon(
        [
          [width / 2, 0],
          [width, height / 2],
          [width / 2, height],
          [0, height / 2],
        ],
        options,
      ),
    ];
  }
  if (element.type !== "line" && element.type !== "arrow") return [];
  const points = element.points.map(
    ([x, y]) => [finiteNumber(x, 0), finiteNumber(y, 0)] as [number, number],
  );
  if (points.length === 0) return [];
  const drawables: Drawable[] = [generator.linearPath(points, options)];
  if (element.type !== "arrow" || points.length < 2) return drawables;
  const end = points.at(-1)!;
  const previous = points.at(-2)!;
  const angle = Math.atan2(end[1] - previous[1], end[0] - previous[0]);
  const arrowheadSize = Math.max(
    8,
    readElementNumber(element, "strokeWidth", 1) * 4,
  );
  const arrowheadOptions: Options = {
    ...options,
    roughness: Math.min(1, options.roughness ?? 1),
    seed: (options.seed ?? 1) + 1,
    strokeLineDash: undefined,
    disableMultiStroke: false,
  };
  drawables.push(
    generator.line(
      end[0],
      end[1],
      end[0] - Math.cos(angle - Math.PI / 6) * arrowheadSize,
      end[1] - Math.sin(angle - Math.PI / 6) * arrowheadSize,
      arrowheadOptions,
    ),
    generator.line(
      end[0],
      end[1],
      end[0] - Math.cos(angle + Math.PI / 6) * arrowheadSize,
      end[1] - Math.sin(angle + Math.PI / 6) * arrowheadSize,
      { ...arrowheadOptions, seed: (arrowheadOptions.seed ?? 1) + 1 },
    ),
  );
  return drawables;
}

function getRoughOptions(
  element: WhiteboardElement,
  theme: WhiteboardTheme,
): Options {
  const strokeWidth = Math.max(
    0.5,
    readElementNumber(element, "strokeWidth", 1),
  );
  const dash = lineDashFor(element);
  const roughness = Math.min(
    2,
    Math.max(0, readElementNumber(element, "roughness", 1)),
  );
  const background = readElementString(
    element,
    "backgroundColor",
    "transparent",
  );
  const strokeStyle = readElementString(element, "strokeStyle", "solid");
  return {
    seed: stableElementSeed(element.id),
    stroke: resolveOwnedThemeColor(
      readElementString(element, "strokeColor", "#1e1e1e"),
      theme,
    ),
    strokeWidth: strokeStyle === "solid" ? strokeWidth : strokeWidth + 0.5,
    strokeLineDash: dash.length > 0 ? [...dash] : undefined,
    disableMultiStroke: strokeStyle !== "solid",
    fill:
      background === "transparent"
        ? undefined
        : resolveOwnedThemeColor(background, theme),
    fillStyle: readElementString(element, "fillStyle", "solid"),
    fillWeight: strokeWidth / 2,
    hachureGap: strokeWidth * 4,
    roughness,
    preserveVertices: roughness < 2,
  };
}

export function lineDashFor(element: WhiteboardElement): readonly number[] {
  const style = readElementString(element, "strokeStyle", "solid");
  if (style === "dashed") return [8, 6];
  if (style === "dotted") return [2, 4];
  return [];
}

function stableElementSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 2_147_483_646) + 1;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
