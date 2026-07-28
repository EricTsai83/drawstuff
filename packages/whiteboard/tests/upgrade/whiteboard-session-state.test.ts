import { describe, expect, it } from "vitest";
import {
  createWhiteboardSessionStateV1,
  parseWhiteboardSessionStateV1,
  serializeWhiteboardSessionStateV1,
} from "@drawstuff/whiteboard";

describe("whiteboard session state", () => {
  it("round-trips editor-only state and sorts scene viewport keys", () => {
    const session = createWhiteboardSessionStateV1({
      activeTool: "freedraw",
      toolLocked: true,
      openPanel: "properties",
      sceneViewports: {
        sceneB: viewport(20),
        sceneA: viewport(10),
      },
    });

    const serialized = serializeWhiteboardSessionStateV1(session);

    expect(parseWhiteboardSessionStateV1(serialized)).toEqual(session);
    expect(serialized.indexOf("sceneA")).toBeLessThan(
      serialized.indexOf("sceneB"),
    );
  });

  it.each([
    "{not-json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      ...createWhiteboardSessionStateV1(),
      viewport: { ...viewport(0), zoom: 0 },
    }),
    JSON.stringify({
      ...createWhiteboardSessionStateV1(),
      activeTool: "laser",
    }),
  ])("rejects corrupt session data without a document dependency", (input) => {
    expect(() => parseWhiteboardSessionStateV1(input)).toThrow();
  });
});

function viewport(x: number) {
  return {
    x,
    y: 0,
    zoom: 1,
    width: 800,
    height: 600,
    offsetX: 0,
    offsetY: 0,
  };
}
