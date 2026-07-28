import { describe, expect, it } from "vitest";
import {
  snapMoveDelta,
  snapResizePoint,
  snapRotation,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../helpers";

describe("owned whiteboard snapping", () => {
  it("snaps selection edges and centers within screen-space thresholds", () => {
    const candidate = createTestElementV3({
      id: "candidate",
      x: 105,
      y: 200,
      width: 100,
      height: 50,
    });
    const result = snapMoveDelta({
      selectionBounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      candidates: [candidate],
      delta: { x: 1, y: 150 },
      zoom: 1,
      pointerType: "mouse",
    });

    expect(result.delta).toEqual({ x: 5, y: 150 });
    expect(result.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ axis: "x", position: 105 }),
        expect.objectContaining({ axis: "y", position: 200 }),
      ]),
    );
  });

  it("uses the larger touch threshold, supports grid, and can be disabled", () => {
    const touch = snapMoveDelta({
      selectionBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      candidates: [createTestElementV3({ id: "candidate", x: 18, y: 100 })],
      delta: { x: 0, y: 0 },
      zoom: 1,
      pointerType: "touch",
    });
    const grid = snapMoveDelta({
      selectionBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      candidates: [],
      delta: { x: 7, y: 12 },
      zoom: 1,
      pointerType: "mouse",
      gridSize: 10,
    });
    const disabled = snapMoveDelta({
      selectionBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      candidates: [],
      delta: { x: 7, y: 12 },
      zoom: 1,
      pointerType: "mouse",
      gridSize: 10,
      disabled: true,
    });

    expect(touch.delta.x).toBe(8);
    expect(grid.delta).toEqual({ x: 5, y: 10 });
    expect(disabled).toEqual({ delta: { x: 7, y: 12 }, guides: [] });
  });

  it("snaps resize handles and Shift rotation", () => {
    const resize = snapResizePoint({
      point: { x: 96, y: 54 },
      candidates: [
        createTestElementV3({
          id: "candidate",
          x: 100,
          y: 50,
          width: 20,
          height: 20,
        }),
      ],
      zoom: 1,
      pointerType: "pen",
    });

    expect(resize.point).toEqual({ x: 100, y: 50 });
    expect(snapRotation(0.3, true)).toBeCloseTo(Math.PI / 12);
    expect(snapRotation(0.3, false)).toBe(0.3);
  });
});
