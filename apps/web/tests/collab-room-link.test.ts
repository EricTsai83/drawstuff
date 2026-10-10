// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRoomInviteUrl,
  COLLABORATION_ROOM_PARAM,
  readRoomIdFromUrl,
  stripLegacyRoomKeyFragment,
} from "@/lib/collab/room-link";

const ROOM_ID = "room-alpha";
const BASE_URL = "https://drawstuff.example/editor?tab=scenes#leftover";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("collaboration invitation links", () => {
  it("is just the room id in the query string, with no fragment", () => {
    const url = buildRoomInviteUrl({ currentUrl: BASE_URL, roomId: ROOM_ID });
    expect(url).toBe(
      `https://drawstuff.example/editor?${COLLABORATION_ROOM_PARAM}=${ROOM_ID}`,
    );
    expect(new URL(url).hash).toBe("");
  });

  it("reads the room id back and ignores an old key fragment", () => {
    expect(
      readRoomIdFromUrl(
        `https://drawstuff.example/?${COLLABORATION_ROOM_PARAM}=${ROOM_ID}#collab-key=abc`,
      ),
    ).toBe(ROOM_ID);
    expect(readRoomIdFromUrl("https://drawstuff.example/")).toBeNull();
    expect(
      readRoomIdFromUrl(
        `https://drawstuff.example/?${COLLABORATION_ROOM_PARAM}=room%2F..%2Fa`,
      ),
    ).toBeNull();
  });

  it("strips an old `#collab-key=` fragment from the address bar", () => {
    window.history.replaceState(
      null,
      "",
      `/editor?${COLLABORATION_ROOM_PARAM}=${ROOM_ID}#collab-key=abc`,
    );
    stripLegacyRoomKeyFragment();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe(
      `?${COLLABORATION_ROOM_PARAM}=${ROOM_ID}`,
    );
  });

  it("leaves unrelated fragments alone", () => {
    window.history.replaceState(null, "", "/editor#zoom=2");
    stripLegacyRoomKeyFragment();
    expect(window.location.hash).toBe("#zoom=2");
  });
});
