import { generateNKeysBetween } from "fractional-indexing";

import type {
  AppState,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

/**
 * Fixed timestamp shared by generated elements so tombstone-timeout checks
 * are deterministic: the tests drive a manual clock anchored to it.
 */
export const COLLAB_SCENE_FIXED_NOW = 1_710_000_000_000;

let orderKeyCursor = 0;
const orderKeys = generateNKeysBetween(null, null, 512);

/** Next strictly-increasing fractional order key for appended elements. */
function nextOrderKey(): string {
  const key = orderKeys[orderKeyCursor];
  orderKeyCursor = (orderKeyCursor + 1) % orderKeys.length;
  return key ?? "a0";
}

/**
 * A native-shaped rectangle that survives upstream `restoreElements`
 * unchanged (the restore fixed-point form, mirroring the adapter package's
 * reconciliation fixtures), so wire round-trips keep scenes deep-equal.
 */
export function collabRectangle(
  overrides: Record<string, unknown> & { readonly id: string },
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
    seed: 7,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: [],
    updated: COLLAB_SCENE_FIXED_NOW,
    link: null,
    locked: false,
    index: nextOrderKey(),
    ...overrides,
  } as unknown as OrderedExcalidrawElement;
}

/**
 * A native-shaped image element in its saved state, so it carries a `fileId` the
 * asset pipeline has to resolve. Same restore fixed-point requirement as
 * `collabRectangle`: the element itself must survive a wire round-trip unchanged,
 * because the bytes travel on a completely separate path.
 */
export function collabImage(
  overrides: Record<string, unknown> & {
    readonly id: string;
    readonly fileId: string;
  },
): OrderedExcalidrawElement {
  return collabRectangle({
    ...overrides,
    type: "image",
    status: "saved",
    scale: [1, 1],
    crop: null,
    roundness: null,
    width: 100,
    height: 80,
  });
}

/** A copy of `element` with one semantic edit and the upstream version bump. */
export function editedElement(
  element: OrderedExcalidrawElement,
  overrides: Record<string, unknown> = {},
): OrderedExcalidrawElement {
  return {
    ...element,
    version: element.version + 1,
    versionNonce: element.versionNonce + 7,
    updated: element.updated + 1,
    ...overrides,
  } as unknown as OrderedExcalidrawElement;
}

export function collabAppState(
  selectedElementIds: readonly string[] = [],
): AppState {
  return {
    selectedElementIds: Object.fromEntries(
      selectedElementIds.map((id) => [id, true as const]),
    ),
  } as unknown as AppState;
}

export function sortSceneById(
  elements: readonly OrderedExcalidrawElement[],
): OrderedExcalidrawElement[] {
  return [...elements].sort((a, b) => a.id.localeCompare(b.id));
}
