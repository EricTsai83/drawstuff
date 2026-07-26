import { describe, expect, it } from "vitest";
import type {
  WhiteboardElement,
  WhiteboardViewport,
} from "@/features/whiteboard";
import {
  documentToScreen,
  elementsInBounds,
  getDocumentBounds,
  getElementGeometry,
  hitTestElements,
  normalizeBounds,
  screenToDocument,
  zoomViewportAt,
} from "@/features/whiteboard/owned";
import { OWNED_CANVAS_PERFORMANCE_FIXTURES } from "../fixtures/owned-canvas/performance";

const viewport: WhiteboardViewport = {
  x: 40,
  y: -20,
  zoom: 2,
  width: 800,
  height: 600,
  offsetX: 100,
  offsetY: 50,
};

describe("owned whiteboard geometry", () => {
  it("round-trips document and screen coordinates with viewport offsets", () => {
    const documentPoint = { x: 25, y: 30 };
    const screenPoint = documentToScreen(documentPoint, viewport);

    expect(screenPoint).toEqual({ x: 230, y: 70 });
    expect(screenToDocument(screenPoint, viewport)).toEqual(documentPoint);
  });

  it("keeps the document point under the zoom anchor fixed", () => {
    const anchor = { x: 350, y: 240 };
    const documentPoint = screenToDocument(anchor, viewport);
    const nextViewport = {
      ...viewport,
      ...zoomViewportAt(viewport, 3, anchor),
    };

    expect(screenToDocument(anchor, nextViewport).x).toBeCloseTo(
      documentPoint.x,
    );
    expect(screenToDocument(anchor, nextViewport).y).toBeCloseTo(
      documentPoint.y,
    );
  });

  it("computes axis-aligned bounds for rotated elements", () => {
    const geometry = getElementGeometry(
      element({
        id: "rotated",
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        angle: Math.PI / 2,
      }),
    );

    expect(geometry?.bounds.minX).toBeCloseTo(40);
    expect(geometry?.bounds.maxX).toBeCloseTo(80);
    expect(geometry?.bounds.minY).toBeCloseTo(-10);
    expect(geometry?.bounds.maxY).toBeCloseTo(90);
  });

  it("hit tests in reverse paint order while skipping locked, hidden, and deleted elements", () => {
    const elements = [
      element({ id: "bottom" }),
      element({ id: "locked", locked: true }),
      element({ id: "hidden", hidden: true }),
      element({ id: "deleted", isDeleted: true }),
    ];

    expect(hitTestElements(elements, { x: 10, y: 10 })?.id).toBe("bottom");
    expect(
      hitTestElements([...elements, element({ id: "painted-last" })], {
        x: 10,
        y: 10,
      })?.id,
    ).toBe("painted-last");
  });

  it("keeps zero-opacity elements selectable so their style can be recovered", () => {
    expect(
      hitTestElements(
        [element({ id: "bottom" }), element({ id: "transparent", opacity: 0 })],
        { x: 10, y: 10 },
      )?.id,
    ).toBe("transparent");
  });

  it("uses shape-aware hit testing and marquee intersection", () => {
    const ellipse = element({ id: "ellipse", type: "ellipse" });
    const rectangle = element({ id: "rectangle", x: 80 });

    expect(hitTestElements([ellipse], { x: 1, y: 1 })).toBeNull();
    expect(hitTestElements([ellipse], { x: 50, y: 30 })?.id).toBe("ellipse");
    expect(
      elementsInBounds(
        [ellipse, rectangle],
        normalizeBounds({ x: 70, y: 10 }, { x: 100, y: 40 }),
      ).map((item) => item.id),
    ).toEqual(["ellipse", "rectangle"]);
  });

  it.each(OWNED_CANVAS_PERFORMANCE_FIXTURES)(
    "provides a repeatable $name read-only geometry baseline",
    ({ document, expectedElementCount }) => {
      const startedAt = performance.now();
      const bounds = getDocumentBounds(document.elements);
      const elapsed = performance.now() - startedAt;

      expect(document.elements).toHaveLength(expectedElementCount);
      expect(bounds).not.toBeNull();
      expect(elapsed).toBeLessThan(500);
    },
  );
});

function element(update: Readonly<Record<string, unknown>>): WhiteboardElement {
  return {
    id: "element",
    type: "rectangle",
    isDeleted: false,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    ...update,
  } as unknown as WhiteboardElement;
}
