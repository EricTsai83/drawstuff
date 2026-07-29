import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createOwnedSceneDocumentV4,
  parseDrawstuffDocument,
  serializeDrawstuffDocumentV4,
} from "@/lib/excalidraw-document-v4";
import {
  CONTROLLER_EVENT_COUNT,
  createControllerNotificationTrace,
  createLargeSceneElements,
  EXCALIDRAW_PERFORMANCE_BUDGETS,
  LARGE_SCENE_ELEMENT_COUNT,
  countSemanticControllerNotifications,
} from "./support/excalidraw-performance-fixtures";

const LARGE_SCENE_FIXTURE_DIGEST =
  "fcb1b639a8bb4952389e7ede840fc759e027c39acb4f0d512cf960f0137d90b2";

describe("Plan 00 performance fixtures", () => {
  it("keeps the large-scene fixture deterministic and native-shaped", () => {
    const elements = createLargeSceneElements();

    expect(elements).toHaveLength(LARGE_SCENE_ELEMENT_COUNT);
    expect(elements.filter(({ isDeleted }) => isDeleted)).toHaveLength(500);
    expect(digest(elements)).toBe(LARGE_SCENE_FIXTURE_DIGEST);
  });

  it("preserves the large scene through the V4 owned-scene boundary", () => {
    const elements = createLargeSceneElements();
    const serialized = serializeDrawstuffDocumentV4(
      createOwnedSceneDocumentV4({
        elements,
        appState: {
          gridSize: 20,
          gridStep: 5,
          gridModeEnabled: true,
          viewBackgroundColor: "#ffffff",
        },
        name: "Plan 00 performance fixture",
      }),
    );
    const parsed = parseDrawstuffDocument(serialized);

    expect(parsed.scene.elements).toHaveLength(LARGE_SCENE_ELEMENT_COUNT);
    expect(digest(parsed.scene.elements)).toBe(LARGE_SCENE_FIXTURE_DIGEST);
    expect(parsed.scene.elements[1]).toMatchObject({
      id: "performance-rectangle-1",
      index: "a1",
      versionNonce: 100_001,
      customData: {
        fixture: "plan-00-large-scene-v1",
        ordinal: 1,
      },
    });
  });

  it("defines a notification trace that ignores pointer-only changes", () => {
    const trace = createControllerNotificationTrace();

    expect(trace).toHaveLength(CONTROLLER_EVENT_COUNT);
    expect(countSemanticControllerNotifications(trace)).toBe(
      EXCALIDRAW_PERFORMANCE_BUDGETS.controllerSemanticNotifications,
    );
  });
});

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
