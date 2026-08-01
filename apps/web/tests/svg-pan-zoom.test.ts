import { describe, expect, it } from "vitest";

import {
  centerTransform,
  clampScale,
  distanceBetween,
  fitTransform,
  IDENTITY_TRANSFORM,
  midpoint,
  panBy,
  parseSvgSize,
  pinchTransform,
  toTransformStyle,
  zoomAtPoint,
  type Point,
  type Transform,
} from "@/hooks/excalidraw/use-svg-pan-zoom";

const LIMITS = { minScale: 0.25, maxScale: 6 } as const;
const VIEWPORT = { width: 800, height: 600 } as const;

/** Where a content point lands in the viewport under `transform`. */
function project(transform: Transform, content: Point): Point {
  return {
    x: transform.x + content.x * transform.scale,
    y: transform.y + content.y * transform.scale,
  };
}

/** Which content point sits under a viewport point. */
function unproject(transform: Transform, viewportPoint: Point): Point {
  return {
    x: (viewportPoint.x - transform.x) / transform.scale,
    y: (viewportPoint.y - transform.y) / transform.scale,
  };
}

describe("pinchTransform", () => {
  it("pans by the midpoint movement when the distance is unchanged", () => {
    const before = { x: -50, y: 20, scale: 1.5 };

    const after = pinchTransform(
      before,
      {
        previousMidpoint: { x: 200, y: 300 },
        currentMidpoint: { x: 230, y: 260 },
        previousDistance: 120,
        currentDistance: 120,
      },
      LIMITS,
    );

    expect(after.scale).toBe(before.scale);
    expect(after.x).toBeCloseTo(before.x + 30, 10);
    expect(after.y).toBeCloseTo(before.y - 40, 10);
  });

  it("keeps the content point under the previous midpoint pinned to the current midpoint", () => {
    const before = { x: 80, y: -35, scale: 2 };
    const previousMidpoint = { x: 400, y: 300 };
    const currentMidpoint = { x: 340, y: 350 };
    const anchored = unproject(before, previousMidpoint);

    const after = pinchTransform(
      before,
      {
        previousMidpoint,
        currentMidpoint,
        previousDistance: 100,
        currentDistance: 150,
      },
      LIMITS,
    );

    expect(after.scale).toBeCloseTo(3, 10);
    expect(project(after, anchored).x).toBeCloseTo(currentMidpoint.x, 10);
    expect(project(after, anchored).y).toBeCloseTo(currentMidpoint.y, 10);
  });

  it("still pans when the zoom is clamped at the limit", () => {
    const before = { x: 0, y: 0, scale: LIMITS.maxScale };

    const after = pinchTransform(
      before,
      {
        previousMidpoint: { x: 100, y: 100 },
        currentMidpoint: { x: 90, y: 130 },
        previousDistance: 100,
        currentDistance: 200,
      },
      LIMITS,
    );

    expect(after.scale).toBe(LIMITS.maxScale);
    expect(after.x).toBeCloseTo(before.x - 10, 10);
    expect(after.y).toBeCloseTo(before.y + 30, 10);
  });
});

describe("clampScale", () => {
  it("keeps the scale inside the configured range", () => {
    expect(clampScale(1, LIMITS)).toBe(1);
    expect(clampScale(0.01, LIMITS)).toBe(LIMITS.minScale);
    expect(clampScale(1000, LIMITS)).toBe(LIMITS.maxScale);
  });
});

describe("zoomAtPoint", () => {
  it("pins the content point under the cursor", () => {
    const cursor = { x: 610, y: 128 };
    const before = { x: -120, y: 40, scale: 1.5 };
    const anchored = unproject(before, cursor);

    const after = zoomAtPoint(before, 1.2, cursor, LIMITS);

    expect(after.scale).toBeCloseTo(1.8, 10);
    expect(project(after, anchored).x).toBeCloseTo(cursor.x, 10);
    expect(project(after, anchored).y).toBeCloseTo(cursor.y, 10);
  });

  it("round-trips a zoom in and out at the same point", () => {
    const cursor = { x: 42, y: 314 };
    const zoomedIn = zoomAtPoint(IDENTITY_TRANSFORM, 2, cursor, LIMITS);
    const zoomedOut = zoomAtPoint(zoomedIn, 0.5, cursor, LIMITS);

    expect(zoomedOut.scale).toBeCloseTo(IDENTITY_TRANSFORM.scale, 10);
    expect(zoomedOut.x).toBeCloseTo(IDENTITY_TRANSFORM.x, 10);
    expect(zoomedOut.y).toBeCloseTo(IDENTITY_TRANSFORM.y, 10);
  });

  it("clamps at both ends and stops translating once clamped", () => {
    const cursor = { x: 300, y: 200 };

    const atMax = zoomAtPoint(
      { x: 10, y: 20, scale: LIMITS.maxScale },
      2,
      cursor,
      LIMITS,
    );
    const atMin = zoomAtPoint(
      { x: 10, y: 20, scale: LIMITS.minScale },
      0.5,
      cursor,
      LIMITS,
    );

    // The transform is returned unchanged, so a clamped wheel gesture cannot
    // drift the scene sideways.
    expect(atMax).toEqual({ x: 10, y: 20, scale: LIMITS.maxScale });
    expect(atMin).toEqual({ x: 10, y: 20, scale: LIMITS.minScale });
  });

  it("clamps a partially applied zoom while still pinning the cursor", () => {
    const cursor = { x: 100, y: 100 };
    const before = { x: 0, y: 0, scale: 4 };
    const anchored = unproject(before, cursor);

    const after = zoomAtPoint(before, 4, cursor, LIMITS);

    expect(after.scale).toBe(LIMITS.maxScale);
    expect(project(after, anchored).x).toBeCloseTo(cursor.x, 10);
    expect(project(after, anchored).y).toBeCloseTo(cursor.y, 10);
  });
});

describe("panBy", () => {
  it("translates without touching the scale", () => {
    expect(panBy({ x: 5, y: -5, scale: 2 }, 10, 20)).toEqual({
      x: 15,
      y: 15,
      scale: 2,
    });
  });
});

describe("centerTransform", () => {
  it("centres the scaled content in the viewport", () => {
    const content = { width: 400, height: 200 };

    const centered = centerTransform(content, VIEWPORT, 1);

    expect(centered).toEqual({ x: 200, y: 200, scale: 1 });
    expect(
      project(centered, { x: content.width / 2, y: content.height / 2 }),
    ).toEqual({ x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 });
  });

  it("keeps the centre fixed when the content is larger than the viewport", () => {
    const content = { width: 2000, height: 1000 };

    const centered = centerTransform(content, VIEWPORT, 2);

    expect(
      project(centered, { x: content.width / 2, y: content.height / 2 }),
    ).toEqual({ x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 });
  });
});

describe("fitTransform", () => {
  const options = { ...LIMITS, margin: 32 };

  it("fits by the constraining axis and leaves the margin", () => {
    const content = { width: 1600, height: 400 };

    const fitted = fitTransform(content, VIEWPORT, options);

    // Width constrains: (800 - 64) / 1600.
    expect(fitted.scale).toBeCloseTo(0.46, 10);
    expect(fitted.x).toBeCloseTo(options.margin, 10);
    expect(project(fitted, { x: content.width, y: 0 }).x).toBeCloseTo(
      VIEWPORT.width - options.margin,
      10,
    );
  });

  it("fits by height when height is the constraining axis", () => {
    const content = { width: 100, height: 2000 };

    const fitted = fitTransform(content, VIEWPORT, options);

    expect(fitted.scale).toBeCloseTo((600 - 64) / 2000, 10);
    expect(fitted.y).toBeCloseTo(options.margin, 10);
  });

  it("never zooms past the configured maximum for a tiny scene", () => {
    const fitted = fitTransform({ width: 4, height: 4 }, VIEWPORT, options);

    expect(fitted.scale).toBe(LIMITS.maxScale);
    expect(project(fitted, { x: 2, y: 2 })).toEqual({
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
    });
  });

  it("never zooms below the configured minimum for a huge scene", () => {
    const fitted = fitTransform(
      { width: 100_000, height: 100_000 },
      VIEWPORT,
      options,
    );

    expect(fitted.scale).toBe(LIMITS.minScale);
  });

  it("falls back to a centred identity scale for empty content", () => {
    const fitted = fitTransform({ width: 0, height: 0 }, VIEWPORT, options);

    expect(fitted).toEqual({
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
      scale: 1,
    });
  });

  it("still produces a finite transform when the viewport is smaller than the margin", () => {
    const fitted = fitTransform(
      { width: 100, height: 100 },
      { width: 10, height: 10 },
      options,
    );

    expect(Number.isFinite(fitted.scale)).toBe(true);
    expect(fitted.scale).toBe(LIMITS.minScale);
  });
});

describe("parseSvgSize", () => {
  it("prefers the px width/height attributes exportToSvg writes", () => {
    expect(parseSvgSize("640.5", "480", "0 0 1280 960")).toEqual({
      width: 640.5,
      height: 480,
    });
  });

  it("falls back to the viewBox, comma- or space-separated", () => {
    expect(parseSvgSize(null, null, "0 0 1280 960")).toEqual({
      width: 1280,
      height: 960,
    });
    expect(parseSvgSize("0", "0", "0,0,320,240")).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("reports a zero size when neither source is usable", () => {
    expect(parseSvgSize(null, null, null)).toEqual({ width: 0, height: 0 });
    expect(parseSvgSize("auto", "auto", "0 0 0 0")).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe("pinch helpers", () => {
  it("measures distance and midpoint between two pointers", () => {
    const first = { x: 0, y: 0 };
    const second = { x: 30, y: 40 };

    expect(distanceBetween(first, second)).toBe(50);
    expect(midpoint(first, second)).toEqual({ x: 15, y: 20 });
  });
});

describe("toTransformStyle", () => {
  it("emits a top-left anchored CSS transform", () => {
    expect(toTransformStyle({ x: 12, y: -3, scale: 1.25 })).toEqual({
      transform: "translate(12px, -3px) scale(1.25)",
      transformOrigin: "0 0",
    });
  });
});
