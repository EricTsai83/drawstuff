import { generateNKeysBetween } from "fractional-indexing";

export const LARGE_SCENE_ELEMENT_COUNT = 5_000;
export const CONTROLLER_EVENT_COUNT = 10_003;

export const EXCALIDRAW_PERFORMANCE_BUDGETS = {
  editorInteractionP95Ms: 140,
  largeSceneLoadP95Ms: 15,
  largeSceneOwnedSaveP95Ms: 15,
  largeSceneReadonlySaveP95Ms: 15,
  controllerTraceP95Ms: 2,
  controllerSemanticNotifications: 3,
  routeJavaScriptRawBytes: 3_670_016,
  routeJavaScriptGzipBytes: 1_101_005,
  nodeWorkingHeapDeltaBytes: 16_777_216,
  nodeRetainedHeapDeltaBytes: 2_097_152,
} as const;

export type PerformanceElement = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly isDeleted: boolean;
};

export type ControllerTraceEvent = {
  readonly activeTool: "selection" | "rectangle";
  readonly selectedElementIds: readonly string[];
  readonly pointerRevision: number;
};

export function createLargeSceneElements(): readonly PerformanceElement[] {
  const orderKeys = generateNKeysBetween(null, null, LARGE_SCENE_ELEMENT_COUNT);

  return Array.from({ length: LARGE_SCENE_ELEMENT_COUNT }, (_, index) => ({
    id: `performance-rectangle-${index}`,
    type: "rectangle",
    x: (index % 100) * 24,
    y: Math.floor(index / 100) * 24,
    width: 20,
    height: 20,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: index % 2 === 0 ? "#a5d8ff" : "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: orderKeys[index],
    roundness: { type: 3 },
    seed: 10_000 + index,
    version: 1 + (index % 5),
    versionNonce: 100_000 + index,
    isDeleted: index % 10 === 0,
    boundElements: null,
    updated: 1_710_000_000_000 + index,
    link: null,
    locked: false,
    customData: {
      fixture: "plan-00-large-scene-v1",
      ordinal: index,
    },
  }));
}

export function createControllerNotificationTrace(): readonly ControllerTraceEvent[] {
  const noSelection: readonly string[] = [];
  const largeSelection = Array.from(
    { length: 1_000 },
    (_, index) => `performance-rectangle-${index}`,
  );
  const pointerOnlyEvents = Array.from(
    { length: CONTROLLER_EVENT_COUNT - 3 },
    (_, pointerRevision) => ({
      activeTool: "selection" as const,
      selectedElementIds: noSelection,
      pointerRevision,
    }),
  );

  return [
    ...pointerOnlyEvents,
    {
      activeTool: "rectangle",
      selectedElementIds: noSelection,
      pointerRevision: pointerOnlyEvents.length,
    },
    {
      activeTool: "rectangle",
      selectedElementIds: largeSelection,
      pointerRevision: pointerOnlyEvents.length + 1,
    },
    {
      activeTool: "rectangle",
      selectedElementIds: [...largeSelection],
      pointerRevision: pointerOnlyEvents.length + 2,
    },
  ];
}

export function countSemanticControllerNotifications(
  events: readonly ControllerTraceEvent[],
): number {
  let notifications = 0;
  let previousActiveTool: ControllerTraceEvent["activeTool"] | undefined;
  let previousSelectedElementIds:
    ControllerTraceEvent["selectedElementIds"] | undefined;

  for (const event of events) {
    if (
      event.activeTool === previousActiveTool &&
      selectionsAreEqual(event.selectedElementIds, previousSelectedElementIds)
    ) {
      continue;
    }

    previousActiveTool = event.activeTool;
    previousSelectedElementIds = event.selectedElementIds;
    notifications += 1;
  }

  return notifications;
}

function selectionsAreEqual(
  current: readonly string[],
  previous: readonly string[] | undefined,
): boolean {
  return (
    current === previous ||
    (current.length === previous?.length &&
      current.every((id, index) => id === previous[index]))
  );
}
