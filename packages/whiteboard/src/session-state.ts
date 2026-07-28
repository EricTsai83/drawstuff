import type {
  WhiteboardElementStyle,
  WhiteboardSessionStateV1,
  WhiteboardToolType,
  WhiteboardViewport,
} from "./contracts";

const TOOL_TYPES = new Set<WhiteboardToolType>([
  "hand",
  "selection",
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "image",
  "eraser",
  "frame",
]);

const DEFAULT_VIEWPORT: WhiteboardViewport = {
  x: 0,
  y: 0,
  zoom: 1,
  width: 0,
  height: 0,
  offsetX: 0,
  offsetY: 0,
};

const DEFAULT_STYLE: WhiteboardElementStyle = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "hachure",
  strokeWidth: 1,
  strokeStyle: "solid",
  opacity: 100,
  roughness: 1,
  roundness: "round",
};

export function createWhiteboardSessionStateV1(
  update: Partial<WhiteboardSessionStateV1> = {},
): WhiteboardSessionStateV1 {
  return parseWhiteboardSessionStateV1({
    version: 1,
    viewport: update.viewport ?? DEFAULT_VIEWPORT,
    activeTool: update.activeTool ?? "selection",
    toolLocked: update.toolLocked ?? false,
    lastUsedStyle: update.lastUsedStyle ?? DEFAULT_STYLE,
    openPanel: update.openPanel ?? null,
    sceneViewports: update.sceneViewports ?? {},
  });
}

export function parseWhiteboardSessionStateV1(
  input: unknown,
): WhiteboardSessionStateV1 {
  const value = typeof input === "string" ? parseJson(input) : input;
  const root = record(value, "$");
  if (root.version !== 1) throw new Error("Unsupported whiteboard session");
  const activeTool = root.activeTool;
  if (
    typeof activeTool !== "string" ||
    !TOOL_TYPES.has(activeTool as WhiteboardToolType)
  ) {
    throw new Error("Invalid whiteboard session tool");
  }
  const sceneViewports = record(root.sceneViewports, "$.sceneViewports");
  return {
    version: 1,
    viewport: viewport(root.viewport, "$.viewport"),
    activeTool: activeTool as WhiteboardToolType,
    toolLocked: booleanValue(root.toolLocked, "$.toolLocked"),
    lastUsedStyle: style(root.lastUsedStyle),
    openPanel:
      root.openPanel === null
        ? null
        : stringValue(root.openPanel, "$.openPanel"),
    sceneViewports: Object.fromEntries(
      Object.entries(sceneViewports)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sceneId, sceneViewport]) => [
          sceneId,
          viewport(sceneViewport, `$.sceneViewports.${sceneId}`),
        ]),
    ),
  };
}

export function serializeWhiteboardSessionStateV1(
  state: WhiteboardSessionStateV1,
): string {
  return JSON.stringify(parseWhiteboardSessionStateV1(state));
}

function viewport(input: unknown, path: string): WhiteboardViewport {
  const value = record(input, path);
  const zoom = numberValue(value.zoom, `${path}.zoom`);
  if (zoom <= 0) throw new Error(`${path}.zoom must be positive`);
  return {
    x: numberValue(value.x, `${path}.x`),
    y: numberValue(value.y, `${path}.y`),
    zoom,
    width: nonNegative(value.width, `${path}.width`),
    height: nonNegative(value.height, `${path}.height`),
    offsetX: numberValue(value.offsetX, `${path}.offsetX`),
    offsetY: numberValue(value.offsetY, `${path}.offsetY`),
  };
}

function style(input: unknown): WhiteboardElementStyle {
  const value = record(input, "$.lastUsedStyle");
  const fillStyle = value.fillStyle;
  const strokeStyle = value.strokeStyle;
  const roundness = value.roundness;
  if (
    fillStyle !== "hachure" &&
    fillStyle !== "cross-hatch" &&
    fillStyle !== "solid" &&
    fillStyle !== "zigzag"
  ) {
    throw new Error("Invalid session fill style");
  }
  if (
    strokeStyle !== "solid" &&
    strokeStyle !== "dashed" &&
    strokeStyle !== "dotted"
  ) {
    throw new Error("Invalid session stroke style");
  }
  if (
    roundness !== undefined &&
    roundness !== "sharp" &&
    roundness !== "round"
  ) {
    throw new Error("Invalid session edge style");
  }
  return {
    strokeColor: stringValue(value.strokeColor, "$.lastUsedStyle.strokeColor"),
    backgroundColor: stringValue(
      value.backgroundColor,
      "$.lastUsedStyle.backgroundColor",
    ),
    fillStyle,
    strokeWidth: nonNegative(value.strokeWidth, "$.lastUsedStyle.strokeWidth"),
    strokeStyle,
    opacity: range(value.opacity, 0, 100, "$.lastUsedStyle.opacity"),
    ...(value.roughness === undefined
      ? {}
      : {
          roughness: nonNegative(value.roughness, "$.lastUsedStyle.roughness"),
        }),
    ...(roundness === undefined ? {} : { roundness }),
  };
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("Malformed whiteboard session JSON");
  }
}

function record(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be finite`);
  }
  return value;
}

function nonNegative(value: unknown, path: string): number {
  const parsed = numberValue(value, path);
  if (parsed < 0) throw new Error(`${path} must be non-negative`);
  return parsed;
}

function range(value: unknown, min: number, max: number, path: string): number {
  const parsed = numberValue(value, path);
  if (parsed < min || parsed > max) {
    throw new Error(`${path} must be between ${min} and ${max}`);
  }
  return parsed;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}
