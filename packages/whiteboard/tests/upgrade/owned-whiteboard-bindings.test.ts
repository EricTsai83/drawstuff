import { describe, expect, it } from "vitest";
import {
  canBindLinearElement,
  createBindingForTarget,
  getBindingCandidateThreshold,
  getBindingEndpoint,
  updateBoundLinearElement,
  type WhiteboardBindingV3,
  type WhiteboardElement,
  type WhiteboardLinearElementV3,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../helpers";

describe("owned whiteboard binding geometry", () => {
  it.each([
    ["rectangle", 1],
    ["diamond", 1],
    ["ellipse", 1],
  ] as const)(
    "intersects a rotated %s boundary",
    (type, expectedBoundaryValue) => {
      const target = shape(type, 0.47);
      const binding: WhiteboardBindingV3 = {
        elementId: target.id,
        focus: 0,
        gap: 0,
      };
      const endpoint = getBindingEndpoint(target, { x: 280, y: -100 }, binding);
      const local = toCenteredLocal(target, endpoint);
      const normalizedX = local.x / (target.width / 2);
      const normalizedY = local.y / (target.height / 2);
      const boundaryValue =
        type === "ellipse"
          ? normalizedX ** 2 + normalizedY ** 2
          : type === "diamond"
            ? Math.abs(normalizedX) + Math.abs(normalizedY)
            : Math.max(Math.abs(normalizedX), Math.abs(normalizedY));

      expect(boundaryValue).toBeCloseTo(expectedBoundaryValue, 6);
    },
  );

  it("stores normalized fixed points and follows target transforms", () => {
    const target = shape("rectangle", 0);
    const binding = createBindingForTarget(target, { x: 300, y: 25 }, 4);
    expect(binding.fixedPoint?.[0]).toBeCloseTo(1);
    expect(binding.fixedPoint?.[1]).toBeCloseTo(0.5);

    const arrow = linear("arrow", {
      endBinding: binding,
    });
    const moved = { ...target, x: 100, angle: Math.PI / 2 };
    const updated = updateBoundLinearElement(
      arrow,
      new Map([[target.id, moved]]),
    );
    const end = updated.points.at(-1)!;
    expect([updated.x + end[0], updated.y + end[1]]).toEqual([
      expect.closeTo(150, 5),
      expect.closeTo(79, 5),
    ]);
  });

  it("rejects self, deleted locked arrows, and binding cycles", () => {
    const source = linear("source");
    const target = linear("target", {
      startBinding: {
        elementId: "source",
        focus: 0,
        gap: 0,
      },
    });
    expect(
      canBindLinearElement({
        sourceId: "source",
        target,
        elements: [source, target],
      }),
    ).toBe(false);
    expect(
      canBindLinearElement({
        sourceId: "source",
        target: { ...target, locked: true },
        elements: [source, target],
      }),
    ).toBe(false);
    expect(
      canBindLinearElement({
        sourceId: "source",
        target: source,
        elements: [source],
      }),
    ).toBe(false);
    expect(getBindingCandidateThreshold("touch", 2)).toBe(5);
    expect(getBindingCandidateThreshold("mouse", 2)).toBe(3);
  });
});

function shape(
  type: "rectangle" | "diamond" | "ellipse",
  angle: number,
): WhiteboardElement {
  return createTestElementV3({
    id: "target",
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle,
  });
}

function linear(
  id: string,
  update: Partial<WhiteboardLinearElementV3> = {},
): WhiteboardLinearElementV3 {
  return createTestElementV3({
    id,
    type: "arrow",
    x: -100,
    y: 25,
    width: 100,
    height: 0,
    points: [
      [0, 0],
      [100, 0],
    ],
    startArrowhead: null,
    endArrowhead: "arrow",
    startBinding: null,
    endBinding: null,
    elbowed: false,
    fixedSegments: [],
    ...update,
  }) as WhiteboardLinearElementV3;
}

function toCenteredLocal(
  target: WhiteboardElement,
  point: readonly [number, number],
): { readonly x: number; readonly y: number } {
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  const x = point[0] - centerX;
  const y = point[1] - centerY;
  const cosine = Math.cos(-target.angle);
  const sine = Math.sin(-target.angle);
  return {
    x: x * cosine - y * sine,
    y: x * sine + y * cosine,
  };
}
