import { describe, expect, it } from "vitest";

import { getVisibleSceneBounds } from "@drawstuff/excalidraw-adapter/client";
import type { AppState } from "@drawstuff/excalidraw-adapter/types";

import { fitViewportToFollowBounds } from "@/lib/collab/follow-viewport";

const viewportState = (input: {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
}): AppState =>
  ({
    width: input.width,
    height: input.height,
    scrollX: input.scrollX,
    scrollY: input.scrollY,
    zoom: { value: input.zoom },
  }) as AppState;

describe("follow viewport fitting", () => {
  it("matches a peer's zoom when the two canvases start at different scales", () => {
    const leader = viewportState({
      width: 1_200,
      height: 800,
      scrollX: -120,
      scrollY: -40,
      zoom: 0.8,
    });
    const follower = viewportState({
      width: 900,
      height: 600,
      scrollX: 300,
      scrollY: -500,
      zoom: 0.6,
    });
    const bounds = getVisibleSceneBounds(leader);

    const fitted = fitViewportToFollowBounds(
      [bounds[0], bounds[1], bounds[2], bounds[3]],
      leader.zoom.value,
      follower,
    );

    expect(fitted).not.toBeNull();
    expect(fitted?.zoom.value).toBeCloseTo(leader.zoom.value, 12);

    const followedBounds = getVisibleSceneBounds({
      ...follower,
      ...fitted,
    });
    expect((followedBounds[0] + followedBounds[2]) / 2).toBeCloseTo(
      (bounds[0] + bounds[2]) / 2,
      10,
    );
    expect((followedBounds[1] + followedBounds[3]) / 2).toBeCloseTo(
      (bounds[1] + bounds[3]) / 2,
      10,
    );

    const zoomedLeader = { ...leader, zoom: { value: 0.9 } } as AppState;
    const zoomedBounds = getVisibleSceneBounds(zoomedLeader);
    const zoomedFollower = fitViewportToFollowBounds(
      [zoomedBounds[0], zoomedBounds[1], zoomedBounds[2], zoomedBounds[3]],
      zoomedLeader.zoom.value,
      { ...follower, ...fitted },
    );
    expect(zoomedFollower?.zoom.value).toBeCloseTo(0.9, 12);
  });

  it("ignores degenerate viewport bounds", () => {
    const follower = viewportState({
      width: 1_200,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
    });

    expect(
      fitViewportToFollowBounds([10, 10, 10, 20], 0.8, follower),
    ).toBeNull();
  });
});
