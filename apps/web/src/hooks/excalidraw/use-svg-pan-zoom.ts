"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

/**
 * Pan/zoom for a statically rendered scene (an `exportToSvg` output), applied
 * as a CSS transform on a stage element.
 *
 * The published page does not mount the editor, so none of Excalidraw's own
 * viewport handling is available here. Every transform below is computed by a
 * pure function so the maths is unit-testable without a DOM
 * (`apps/web/tests/svg-pan-zoom.test.ts`); the hook only wires those functions
 * to pointer, wheel and resize events.
 */

export type Transform = {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
};

export type Size = { readonly width: number; readonly height: number };

export type Point = { readonly x: number; readonly y: number };

export type ScaleLimits = {
  readonly minScale: number;
  readonly maxScale: number;
};

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, scale: 1 };

/** Wheel delta (px) → zoom factor exponent. */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** Chrome reports line-based wheel deltas; treat one line as this many px. */
const WHEEL_LINE_HEIGHT = 16;

export function clampScale(scale: number, limits: ScaleLimits): number {
  return Math.min(limits.maxScale, Math.max(limits.minScale, scale));
}

/**
 * Zooms by `factor` while keeping the content point under `origin` (viewport
 * coordinates) pinned to `origin`.
 */
export function zoomAtPoint(
  transform: Transform,
  factor: number,
  origin: Point,
  limits: ScaleLimits,
): Transform {
  const scale = clampScale(transform.scale * factor, limits);
  if (scale === transform.scale) return transform;

  const ratio = scale / transform.scale;

  return {
    scale,
    x: origin.x - (origin.x - transform.x) * ratio,
    y: origin.y - (origin.y - transform.y) * ratio,
  };
}

export function panBy(transform: Transform, dx: number, dy: number): Transform {
  return { ...transform, x: transform.x + dx, y: transform.y + dy };
}

/** Centres `content` inside `viewport` at `scale`. */
export function centerTransform(
  content: Size,
  viewport: Size,
  scale: number,
): Transform {
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  };
}

/**
 * Scales `content` down (or up) so it fits inside `viewport` minus `margin` on
 * every side, then centres it. Replaces upstream's `scrollToContent`.
 */
export function fitTransform(
  content: Size,
  viewport: Size,
  options: ScaleLimits & { readonly margin: number },
): Transform {
  if (content.width <= 0 || content.height <= 0) {
    return centerTransform(content, viewport, clampScale(1, options));
  }

  const available = {
    width: Math.max(1, viewport.width - options.margin * 2),
    height: Math.max(1, viewport.height - options.margin * 2),
  };
  const scale = clampScale(
    Math.min(
      available.width / content.width,
      available.height / content.height,
    ),
    options,
  );

  return centerTransform(content, viewport, scale);
}

export function toTransformStyle(transform: Transform): CSSProperties {
  return {
    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    transformOrigin: "0 0",
  };
}

/**
 * `exportToSvg` writes px `width`/`height` plus a matching `viewBox`, so the
 * attributes are the intrinsic size of the exported scene. The `viewBox`
 * fallback keeps this working if upstream ever drops the px attributes.
 */
export function parseSvgSize(
  width: string | null,
  height: string | null,
  viewBox: string | null,
): Size {
  const attributeSize = {
    width: Number.parseFloat(width ?? ""),
    height: Number.parseFloat(height ?? ""),
  };
  if (attributeSize.width > 0 && attributeSize.height > 0) {
    return attributeSize;
  }

  const parts = (viewBox ?? "")
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  const viewBoxSize = { width: parts[2] ?? 0, height: parts[3] ?? 0 };

  return viewBoxSize.width > 0 && viewBoxSize.height > 0
    ? viewBoxSize
    : { width: 0, height: 0 };
}

export function distanceBetween(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export type PinchGesture = {
  readonly previousMidpoint: Point;
  readonly currentMidpoint: Point;
  readonly previousDistance: number;
  readonly currentDistance: number;
};

/**
 * Applies one pinch step: the content point that was under the previous
 * midpoint ends up under the current midpoint, scaled by the distance ratio.
 * A distance ratio of 1 is a plain two-finger pan; a clamped or unchanged
 * scale still pans.
 */
export function pinchTransform(
  transform: Transform,
  gesture: PinchGesture,
  limits: ScaleLimits,
): Transform {
  const zoomed = zoomAtPoint(
    transform,
    gesture.currentDistance / gesture.previousDistance,
    gesture.previousMidpoint,
    limits,
  );
  return panBy(
    zoomed,
    gesture.currentMidpoint.x - gesture.previousMidpoint.x,
    gesture.currentMidpoint.y - gesture.previousMidpoint.y,
  );
}

function readSvgSize(svg: SVGSVGElement): Size {
  return parseSvgSize(
    svg.getAttribute("width"),
    svg.getAttribute("height"),
    svg.getAttribute("viewBox"),
  );
}

type UseSvgPanZoomOptions = ScaleLimits & {
  /** The exported scene. Replacing it (e.g. on theme change) keeps the view. */
  readonly content: SVGSVGElement | null;
  /**
   * Identity of the scene behind `content`. When it changes the view fits the
   * new scene again; re-exports of the same scene (theme change) keep the
   * current transform.
   */
  readonly contentKey?: unknown;
  readonly margin: number;
};

type UseSvgPanZoomResult = {
  /** Must stay mounted for the hook's lifetime: wheel and pointer listeners
   * are attached once, against the element present on the first commit. */
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly transformStyle: CSSProperties;
  /** False until the first successful fit, so the stage can fade in. */
  readonly hasFitted: boolean;
  readonly fit: () => void;
  readonly reset: () => void;
  readonly zoomBy: (factor: number) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Swallows the click a pan gesture would otherwise fire on a link. */
  readonly onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

/** Movement below this many px still counts as a click, not a pan. */
const CLICK_PAN_TOLERANCE = 4;

export function useSvgPanZoom({
  content,
  contentKey,
  margin,
  maxScale,
  minScale,
}: UseSvgPanZoomOptions): UseSvgPanZoomResult {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchMidpointRef = useRef<Point | null>(null);
  const panDistanceRef = useRef(0);
  const [transform, setTransform] = useState<Transform>(IDENTITY_TRANSFORM);
  const [hasFitted, setHasFitted] = useState(false);
  const previousContentKeyRef = useRef(contentKey);

  // A new scene fits again; a re-export of the same scene keeps the view.
  useEffect(() => {
    if (Object.is(previousContentKeyRef.current, contentKey)) return;
    previousContentKeyRef.current = contentKey;
    setHasFitted(false);
  }, [contentKey]);

  const limits = useMemo<ScaleLimits>(
    () => ({ minScale, maxScale }),
    [maxScale, minScale],
  );
  const contentSize = useMemo(
    () => (content ? readSvgSize(content) : null),
    [content],
  );

  const measureViewport = useCallback((): Size | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;

    const rect = viewport.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { width: rect.width, height: rect.height }
      : null;
  }, []);

  const toViewportPoint = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      x: clientX - (rect?.left ?? 0),
      y: clientY - (rect?.top ?? 0),
    };
  }, []);

  // The exported SVG is a DOM node built outside React, so it is mounted
  // imperatively into a stage element React itself keeps empty.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    if (content) {
      content.style.display = "block";
      stage.replaceChildren(content);
    } else {
      stage.replaceChildren();
    }

    return () => stage.replaceChildren();
  }, [content]);

  const fit = useCallback(() => {
    const viewport = measureViewport();
    if (!viewport || !contentSize) return;

    setTransform(fitTransform(contentSize, viewport, { ...limits, margin }));
    setHasFitted(true);
  }, [contentSize, limits, margin, measureViewport]);

  const reset = useCallback(() => {
    const viewport = measureViewport();
    if (!viewport || !contentSize) return;

    setTransform(centerTransform(contentSize, viewport, 1));
  }, [contentSize, measureViewport]);

  const zoomBy = useCallback(
    (factor: number) => {
      const viewport = measureViewport();
      if (!viewport) return;

      const center = { x: viewport.width / 2, y: viewport.height / 2 };
      setTransform((current) => zoomAtPoint(current, factor, center, limits));
    },
    [limits, measureViewport],
  );

  // Frame the scene once. The viewport can still be 0×0 on the first paint, so
  // a ResizeObserver retries instead of a timer poll; it is torn down as soon
  // as `hasFitted` flips.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !content || hasFitted) return;

    fit();

    const observer = new ResizeObserver(() => fit());
    observer.observe(viewport);

    return () => observer.disconnect();
  }, [content, fit, hasFitted]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();

      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * WHEEL_LINE_HEIGHT
          : event.deltaY;
      const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
      const origin = toViewportPoint(event.clientX, event.clientY);

      setTransform((current) => zoomAtPoint(current, factor, origin, limits));
    };

    // Must be non-passive: the page would scroll otherwise.
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [limits, toViewportPoint]);

  useEffect(() => {
    const pointers = pointersRef.current;

    const handlePointerMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;

      const next = toViewportPoint(event.clientX, event.clientY);
      pointers.set(event.pointerId, next);
      panDistanceRef.current += distanceBetween(previous, next);

      const [first, second] = [...pointers.values()];
      if (first && second) {
        const currentDistance = distanceBetween(first, second);
        const currentMidpoint = midpoint(first, second);
        const previousDistance = pinchDistanceRef.current;
        const previousMidpoint = pinchMidpointRef.current;
        pinchDistanceRef.current = currentDistance;
        pinchMidpointRef.current = currentMidpoint;
        if (!previousDistance || !previousMidpoint || currentDistance <= 0) {
          return;
        }

        setTransform((current) =>
          pinchTransform(
            current,
            {
              previousMidpoint,
              currentMidpoint,
              previousDistance,
              currentDistance,
            },
            limits,
          ),
        );
        return;
      }

      pinchDistanceRef.current = null;
      pinchMidpointRef.current = null;
      setTransform((current) =>
        panBy(current, next.x - previous.x, next.y - previous.y),
      );
    };

    const handlePointerEnd = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      // Any pointer ending can change which two pointers form the active
      // pair, so the pinch baseline is always rebuilt on the next move.
      pinchDistanceRef.current = null;
      pinchMidpointRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      pointers.clear();
    };
  }, [limits, toViewportPoint]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;

      pointersRef.current.set(
        event.pointerId,
        toViewportPoint(event.clientX, event.clientY),
      );
      pinchDistanceRef.current = null;
      pinchMidpointRef.current = null;
      panDistanceRef.current = 0;
    },
    [toViewportPoint],
  );

  // The scene keeps upstream's exported `<a>` anchors clickable, but a pan
  // ends with pointerdown/up on the same element, which the browser reports
  // as a click — swallow it once the gesture moved beyond a tap.
  const onClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (panDistanceRef.current <= CLICK_PAN_TOLERANCE) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  return {
    viewportRef,
    stageRef,
    transformStyle: toTransformStyle(transform),
    hasFitted,
    fit,
    reset,
    zoomBy,
    onPointerDown,
    onClickCapture,
  };
}
