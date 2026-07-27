import type { WhiteboardElement, WhiteboardElementStyle } from "../contracts";
import { normalizeBounds, type WhiteboardPoint } from "./geometry";
import { createOwnedElementRuntimeFields } from "./element-version";

export type OwnedDrawingTool =
  "arrow" | "diamond" | "ellipse" | "frame" | "freedraw" | "line" | "rectangle";

export type OwnedCreatableTool = OwnedDrawingTool | "text";

export interface OwnedDrawingCapabilities {
  readonly arrow: boolean;
  readonly diamond: boolean;
  readonly ellipse: boolean;
  readonly frame: boolean;
  readonly freedraw: boolean;
  readonly line: boolean;
  readonly rectangle: boolean;
  readonly text: boolean;
}

export const DEFAULT_OWNED_DRAWING_CAPABILITIES: OwnedDrawingCapabilities = {
  arrow: true,
  diamond: true,
  ellipse: true,
  frame: true,
  freedraw: true,
  line: true,
  rectangle: true,
  text: true,
};

export interface OwnedDrawingSession {
  readonly tool: OwnedDrawingTool;
  readonly start: WhiteboardPoint;
  end: WhiteboardPoint;
  readonly chunks: WhiteboardPoint[][];
  readonly pressureChunks: number[][];
  pointCount: number;
}

export const OWNED_FREEDRAW_CHUNK_SIZE = 256;

type OwnedBoxDrawingTool = "diamond" | "ellipse" | "frame" | "rectangle";

const BOX_TOOLS = new Set<OwnedBoxDrawingTool>([
  "diamond",
  "ellipse",
  "frame",
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
    tool === "frame" ||
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
  return {
    tool,
    start: point,
    end: point,
    chunks: [[point]],
    pressureChunks: [[0.5]],
    pointCount: 1,
  };
}

export function updateOwnedDrawing(
  session: OwnedDrawingSession,
  point: WhiteboardPoint,
  options?: {
    readonly minDistance?: number;
    readonly pressure?: number;
  },
): OwnedDrawingSession {
  if (session.tool !== "freedraw") {
    session.end = point;
    return session;
  }
  const previousChunk = session.chunks.at(-1);
  const previous = previousChunk?.at(-1);
  const minDistance = Math.max(0, options?.minDistance ?? 0);
  if (
    previous &&
    Math.hypot(previous.x - point.x, previous.y - point.y) <= minDistance
  ) {
    return session;
  }
  let points = previousChunk;
  let pressures = session.pressureChunks.at(-1);
  if (!points || !pressures || points.length >= OWNED_FREEDRAW_CHUNK_SIZE) {
    points = [];
    pressures = [];
    session.chunks.push(points);
    session.pressureChunks.push(pressures);
  }
  points.push(point);
  pressures.push(clampPressure(options?.pressure));
  session.end = point;
  session.pointCount += 1;
  return session;
}

export function createOwnedDrawingElement(
  session: OwnedDrawingSession,
  style: WhiteboardElementStyle,
  id: string,
  options?: { readonly preview?: boolean },
): WhiteboardElement | null {
  const end = session.end;
  const base = {
    ...createOwnedElementRuntimeFields(id),
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
    ...(style.roundness ? { roundness: style.roundness } : {}),
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
      ...(session.tool === "frame"
        ? {
            backgroundColor: "transparent",
            fillStyle: "solid" as const,
            name: "",
          }
        : {}),
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    };
  }

  const points = materializeDrawingPoints(session);
  const bounds = normalizePointBounds(points);
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
    points: points.map(
      (point) => [point.x - bounds.minX, point.y - bounds.minY] as const,
    ),
    ...(session.tool === "freedraw"
      ? {
          pressures: session.pressureChunks.flat(),
          simulatePressure: session.pressureChunks
            .flat()
            .every((pressure) => pressure === 0.5),
          lastCommittedPoint: [
            end.x - bounds.minX,
            end.y - bounds.minY,
          ] as const,
        }
      : {}),
    ...(session.tool === "arrow" || session.tool === "line"
      ? {
          startArrowhead: null,
          endArrowhead: session.tool === "arrow" ? "arrow" : null,
          startBinding: null,
          endBinding: null,
          elbowed: false,
          fixedSegments: [],
        }
      : {}),
  };
}

export function materializeDrawingPoints(
  session: OwnedDrawingSession,
): readonly WhiteboardPoint[] {
  return session.tool === "freedraw"
    ? session.chunks.flat()
    : [session.start, session.end];
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
    ...createOwnedElementRuntimeFields(id),
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
    fontFamily: "excalifont",
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    strokeColor: style.strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    opacity: style.opacity,
    roughness: style.roughness ?? 1,
    ...(style.roundness ? { roundness: style.roundness } : {}),
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

function clampPressure(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(1, value)
    : 0.5;
}
