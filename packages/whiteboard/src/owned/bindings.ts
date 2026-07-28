import type {
  WhiteboardBindingV3,
  WhiteboardElement,
  WhiteboardLinearElementV3,
} from "../contracts";
import type { WhiteboardPoint } from "./geometry";

const MIN_HALF_SIZE = 0.5;
type BindingPoint = WhiteboardPoint | readonly [number, number];

export function getBindingCandidateThreshold(
  pointerType: "mouse" | "pen" | "touch",
  zoom: number,
): number {
  return (pointerType === "touch" ? 10 : 6) / Math.max(0.05, zoom);
}

export function createBindingForTarget(
  target: WhiteboardElement,
  toward: BindingPoint,
  gap = 0,
): WhiteboardBindingV3 {
  const endpoint = getBindingEndpoint(target, toward, {
    elementId: target.id,
    focus: 0,
    gap,
  });
  const local = worldToTargetLocal(target, endpoint);
  return {
    elementId: target.id,
    focus: calculateBoundaryFocus(target, local),
    gap,
    fixedPoint: [
      clamp01(local.x / Math.max(MIN_HALF_SIZE, Math.abs(target.width))),
      clamp01(local.y / Math.max(MIN_HALF_SIZE, Math.abs(target.height))),
    ],
  };
}

export function getBindingEndpoint(
  target: WhiteboardElement,
  toward: BindingPoint,
  binding: WhiteboardBindingV3,
): readonly [number, number] {
  const center = targetCenter(target);
  const localToward = worldToTargetLocal(target, toward);
  const localCenter = {
    x: Math.abs(target.width) / 2,
    y: Math.abs(target.height) / 2,
  };
  const localPoint = binding.fixedPoint
    ? {
        x: clamp01(binding.fixedPoint[0]) * Math.abs(target.width),
        y: clamp01(binding.fixedPoint[1]) * Math.abs(target.height),
      }
    : intersectTargetBoundary(
        target,
        {
          x: localToward.x - localCenter.x,
          y: localToward.y - localCenter.y,
        },
        binding.focus,
      );
  const boundaryPoint = binding.fixedPoint
    ? targetLocalToWorld(target, localPoint)
    : targetLocalToWorld(target, {
        x: localPoint.x + localCenter.x,
        y: localPoint.y + localCenter.y,
      });
  const direction = {
    x: boundaryPoint.x - center.x,
    y: boundaryPoint.y - center.y,
  };
  const length = Math.hypot(direction.x, direction.y) || 1;
  return [
    boundaryPoint.x + (direction.x / length) * binding.gap,
    boundaryPoint.y + (direction.y / length) * binding.gap,
  ];
}

export function updateBoundLinearElement(
  element: WhiteboardLinearElementV3,
  targets: ReadonlyMap<string, WhiteboardElement>,
): WhiteboardLinearElementV3 {
  const worldPoints = element.points.map(
    ([x, y]) => [element.x + x, element.y + y] as [number, number],
  );
  if (worldPoints.length < 2) return element;
  const first = worldPoints[0]!;
  const last = worldPoints.at(-1)!;
  const startTarget = element.startBinding
    ? targets.get(element.startBinding.elementId)
    : null;
  const endTarget = element.endBinding
    ? targets.get(element.endBinding.elementId)
    : null;
  if (startTarget && element.startBinding) {
    worldPoints[0] = [
      ...getBindingEndpoint(startTarget, last, element.startBinding),
    ];
  }
  if (endTarget && element.endBinding) {
    worldPoints[worldPoints.length - 1] = [
      ...getBindingEndpoint(endTarget, first, element.endBinding),
    ];
  }
  const minX = Math.min(...worldPoints.map(([x]) => x));
  const minY = Math.min(...worldPoints.map(([, y]) => y));
  const maxX = Math.max(...worldPoints.map(([x]) => x));
  const maxY = Math.max(...worldPoints.map(([, y]) => y));
  return {
    ...element,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    points: worldPoints.map(([x, y]) => [x - minX, y - minY] as const),
  };
}

export function canBindLinearElement(options: {
  readonly sourceId: string;
  readonly target: WhiteboardElement;
  readonly elements: readonly WhiteboardElement[];
}): boolean {
  if (
    options.target.id === options.sourceId ||
    options.target.isDeleted ||
    (options.target.locked &&
      (options.target.type === "arrow" || options.target.type === "line"))
  ) {
    return false;
  }
  const elementsById = new Map(
    options.elements.map((element) => [element.id, element]),
  );
  const visited = new Set<string>();
  const reachesSource = (id: string): boolean => {
    if (id === options.sourceId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const element = elementsById.get(id);
    if (!element || (element.type !== "arrow" && element.type !== "line")) {
      return false;
    }
    return [element.startBinding, element.endBinding].some(
      (binding) => binding !== null && reachesSource(binding.elementId),
    );
  };
  return !reachesSource(options.target.id);
}

function intersectTargetBoundary(
  target: WhiteboardElement,
  direction: WhiteboardPoint,
  focus: number,
): WhiteboardPoint {
  const halfWidth = Math.max(MIN_HALF_SIZE, Math.abs(target.width) / 2);
  const halfHeight = Math.max(MIN_HALF_SIZE, Math.abs(target.height) / 2);
  const adjusted = applyFocus(direction, focus, halfWidth, halfHeight);
  const x = adjusted.x || Number.EPSILON;
  const y = adjusted.y || Number.EPSILON;
  if (target.type === "ellipse") {
    const scale =
      1 /
      Math.sqrt(
        (x * x) / (halfWidth * halfWidth) + (y * y) / (halfHeight * halfHeight),
      );
    return { x: x * scale, y: y * scale };
  }
  if (target.type === "diamond") {
    const scale = 1 / (Math.abs(x) / halfWidth + Math.abs(y) / halfHeight);
    return { x: x * scale, y: y * scale };
  }
  const scale = 1 / Math.max(Math.abs(x) / halfWidth, Math.abs(y) / halfHeight);
  return { x: x * scale, y: y * scale };
}

function applyFocus(
  direction: WhiteboardPoint,
  focus: number,
  halfWidth: number,
  halfHeight: number,
): WhiteboardPoint {
  const normalizedFocus = clamp(focus, -1, 1);
  const length = Math.hypot(direction.x, direction.y) || 1;
  return {
    x: direction.x - (direction.y / length) * normalizedFocus * halfWidth * 0.5,
    y:
      direction.y + (direction.x / length) * normalizedFocus * halfHeight * 0.5,
  };
}

function calculateBoundaryFocus(
  target: WhiteboardElement,
  local: WhiteboardPoint,
): number {
  const halfWidth = Math.max(MIN_HALF_SIZE, Math.abs(target.width) / 2);
  const halfHeight = Math.max(MIN_HALF_SIZE, Math.abs(target.height) / 2);
  const centered = {
    x: local.x - Math.abs(target.width) / 2,
    y: local.y - Math.abs(target.height) / 2,
  };
  return Math.abs(centered.x / halfWidth) >= Math.abs(centered.y / halfHeight)
    ? clamp(centered.y / halfHeight, -1, 1)
    : clamp(centered.x / halfWidth, -1, 1);
}

function targetCenter(target: WhiteboardElement): WhiteboardPoint {
  return {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
}

function worldToTargetLocal(
  target: WhiteboardElement,
  point: BindingPoint,
): WhiteboardPoint {
  const center = targetCenter(target);
  const normalized = "x" in point ? point : { x: point[0], y: point[1] };
  const cosine = Math.cos(-target.angle);
  const sine = Math.sin(-target.angle);
  const x = normalized.x - center.x;
  const y = normalized.y - center.y;
  return {
    x: x * cosine - y * sine + Math.abs(target.width) / 2,
    y: x * sine + y * cosine + Math.abs(target.height) / 2,
  };
}

function targetLocalToWorld(
  target: WhiteboardElement,
  point: WhiteboardPoint,
): WhiteboardPoint {
  const center = targetCenter(target);
  const x = point.x - Math.abs(target.width) / 2;
  const y = point.y - Math.abs(target.height) / 2;
  const cosine = Math.cos(target.angle);
  const sine = Math.sin(target.angle);
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}
