import type { WhiteboardElement, WhiteboardElementStyle } from "../contracts";
import { normalizeBounds, type WhiteboardPoint } from "./geometry";

export type OwnedDrawingTool =
  "arrow" | "diamond" | "ellipse" | "freedraw" | "line" | "rectangle";

export type OwnedCreatableTool = OwnedDrawingTool | "text";

export interface OwnedDrawingCapabilities {
  readonly arrow: boolean;
  readonly diamond: boolean;
  readonly ellipse: boolean;
  readonly freedraw: boolean;
  readonly line: boolean;
  readonly rectangle: boolean;
  readonly text: boolean;
}

export const DEFAULT_OWNED_DRAWING_CAPABILITIES: OwnedDrawingCapabilities = {
  arrow: true,
  diamond: true,
  ellipse: true,
  freedraw: true,
  line: true,
  rectangle: true,
  text: true,
};

export interface OwnedDrawingSession {
  readonly tool: OwnedDrawingTool;
  readonly start: WhiteboardPoint;
  readonly points: readonly WhiteboardPoint[];
}

type OwnedBoxDrawingTool = "diamond" | "ellipse" | "rectangle";

const BOX_TOOLS = new Set<OwnedBoxDrawingTool>([
  "diamond",
  "ellipse",
  "rectangle",
]);

function isOwnedBoxDrawingTool(
  tool: OwnedDrawingTool,
): tool is OwnedBoxDrawingTool {
  return BOX_TOOLS.has(tool as OwnedBoxDrawingTool);
}

export function isOwnedCreatableTool(tool: string): tool is OwnedCreatableTool {
  return (
    tool === "arrow" ||
    tool === "diamond" ||
    tool === "ellipse" ||
    tool === "freedraw" ||
    tool === "line" ||
    tool === "rectangle" ||
    tool === "text"
  );
}

export function beginOwnedDrawing(
  tool: OwnedDrawingTool,
  point: WhiteboardPoint,
): OwnedDrawingSession {
  return { tool, start: point, points: [point] };
}

export function updateOwnedDrawing(
  session: OwnedDrawingSession,
  point: WhiteboardPoint,
): OwnedDrawingSession {
  if (session.tool !== "freedraw") {
    return { ...session, points: [session.start, point] };
  }
  const previous = session.points.at(-1);
  if (previous?.x === point.x && previous.y === point.y) {
    return session;
  }
  return { ...session, points: [...session.points, point] };
}

export function createOwnedDrawingElement(
  session: OwnedDrawingSession,
  style: WhiteboardElementStyle,
  id: string,
  options?: { readonly preview?: boolean },
): WhiteboardElement | null {
  const end = session.points.at(-1) ?? session.start;
  const base = {
    id,
    type: session.tool,
    isDeleted: false,
    angle: 0,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    opacity: style.opacity,
    roughness: style.roughness ?? 1,
    locked: false,
  } as const;

  if (isOwnedBoxDrawingTool(session.tool)) {
    const bounds = normalizeBounds(session.start, end);
    if (
      !options?.preview &&
      bounds.minX === bounds.maxX &&
      bounds.minY === bounds.maxY
    ) {
      return null;
    }
    return {
      ...base,
      type: session.tool,
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    };
  }

  const bounds = normalizePointBounds(session.points);
  if (
    !options?.preview &&
    bounds.minX === bounds.maxX &&
    bounds.minY === bounds.maxY
  ) {
    return null;
  }
  return {
    ...base,
    type: session.tool,
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    backgroundColor: "transparent",
    fillStyle: "solid",
    points: session.points.map(
      (point) => [point.x - bounds.minX, point.y - bounds.minY] as const,
    ),
  };
}

export function createOwnedTextElement(
  point: WhiteboardPoint,
  text: string,
  style: WhiteboardElementStyle,
  id: string,
  dimensions?: {
    readonly width?: number;
    readonly height?: number;
  },
): WhiteboardElement | null {
  if (text.trim().length === 0) return null;
  const fontSize = 20;
  const lineHeight = 1.25;
  const lines = text.split("\n");
  const estimatedWidth = Math.max(
    1,
    ...lines.map((line) => line.length * fontSize * 0.6),
  );
  const estimatedHeight = Math.max(1, lines.length * fontSize * lineHeight);
  return {
    id,
    type: "text",
    isDeleted: false,
    x: point.x,
    y: point.y,
    width: positiveDimension(dimensions?.width, estimatedWidth),
    height: positiveDimension(dimensions?.height, estimatedHeight),
    angle: 0,
    text,
    originalText: text,
    fontSize,
    lineHeight,
    strokeColor: style.strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    opacity: style.opacity,
    roughness: style.roughness ?? 1,
    locked: false,
  };
}

function positiveDimension(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function createOwnedElementId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `owned-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizePointBounds(points: readonly WhiteboardPoint[]) {
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
  return {
    minX,
    minY,
    maxX,
    maxY,
  };
}
