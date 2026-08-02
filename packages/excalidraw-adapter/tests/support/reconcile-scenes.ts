import { generateNKeysBetween } from "fractional-indexing";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";

/**
 * Fixed timestamp shared by every generated element so tombstone-timeout
 * checks are deterministic: tests pass an explicit `now` relative to it.
 */
export const RECONCILE_SCENE_FIXED_UPDATED = 1_710_000_000_000;

/**
 * Builds a native-shaped rectangle that survives upstream `restoreElements`
 * unchanged (all restore-relevant fields present), with valid, strictly
 * increasing fractional indices supplied by the caller.
 */
export function createSyncRectangle(
  overrides: Record<string, unknown> & {
    readonly id: string;
    readonly index: string;
  },
): OrderedExcalidrawElement {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    // The restore fixed-point form (`restoreElementWithProperties` normalizes
    // null to []), so wire round-trips keep scenes deep-equal.
    boundElements: [],
    updated: RECONCILE_SCENE_FIXED_UPDATED,
    link: null,
    locked: false,
    ...overrides,
  } as unknown as OrderedExcalidrawElement;
}

/**
 * Deterministic large scene for reconciliation measurements: native-shaped
 * rectangles with valid fractional order keys and 10% tombstones, mirroring
 * the `plan-00-large-scene-v1` shape at the requested size.
 */
export function createSyncScene(
  elementCount: number,
): OrderedExcalidrawElement[] {
  const orderKeys = generateNKeysBetween(null, null, elementCount);

  return Array.from({ length: elementCount }, (_, index) =>
    createSyncRectangle({
      id: `sync-rectangle-${index}`,
      index: orderKeys[index] ?? "a0",
      x: (index % 100) * 24,
      y: Math.floor(index / 100) * 24,
      backgroundColor: index % 2 === 0 ? "#a5d8ff" : "transparent",
      seed: 10_000 + index,
      version: 1 + (index % 5),
      versionNonce: 100_000 + index,
      isDeleted: index % 10 === 0,
      updated: RECONCILE_SCENE_FIXED_UPDATED + index,
      customData: { fixture: "plan-10-reconcile-scene", ordinal: index },
    }),
  );
}

/** A copy of `element` with one semantic edit and the upstream version bump. */
export function editElement(
  element: OrderedExcalidrawElement,
  overrides?: Partial<Record<keyof ExcalidrawElement, unknown>>,
): OrderedExcalidrawElement {
  return {
    ...element,
    backgroundColor: "#ffc9c9",
    version: element.version + 1,
    versionNonce: element.versionNonce + 7,
    updated: element.updated + 1,
    ...overrides,
  } as unknown as OrderedExcalidrawElement;
}
