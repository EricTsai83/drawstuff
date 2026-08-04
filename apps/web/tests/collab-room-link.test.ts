import { describe, expect, it } from "vitest";

import {
  generateRoomKey,
  roomKeySchema,
} from "@drawstuff/collaboration/realtime-crypto";

import {
  buildRoomInviteUrl,
  COLLABORATION_ROOM_KEY_FRAGMENT,
  COLLABORATION_ROOM_PARAM,
  readRoomKeyFromHash,
  roomKeyHash,
} from "@/lib/collab/room-link";

/**
 * Threat model for the invitation link (Plan 14, step 6). The room key is the
 * only thing standing between a relay operator and the room's contents, so
 * these tests assert where it may appear — the fragment, and nowhere else.
 */

const ROOM_ID = "room-alpha";
const ROOM_KEY = roomKeySchema.parse(
  "d2ViLXRlc3Qtcm9vbS1rZXktMzItYnl0ZXMtMDAwMDA",
);
const BASE_URL = "https://drawstuff.example/editor?tab=scenes#leftover";

/** What a server, a proxy log, or a `Referer` header would actually receive. */
const requestVisiblePart = (url: string): string => url.split("#")[0] ?? url;

describe("collaboration invitation links", () => {
  it("puts the room id in the query string and the key in the fragment", () => {
    const url = buildRoomInviteUrl({
      currentUrl: BASE_URL,
      roomId: ROOM_ID,
      roomKey: ROOM_KEY,
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get(COLLABORATION_ROOM_PARAM)).toBe(ROOM_ID);
    expect(parsed.hash).toBe(`#${COLLABORATION_ROOM_KEY_FRAGMENT}=${ROOM_KEY}`);
    // Unrelated query params and a stale fragment never ride along.
    expect(parsed.searchParams.get("tab")).toBeNull();
    expect(url).not.toContain("leftover");
  });

  it("keeps the key out of everything a server could observe", () => {
    const url = buildRoomInviteUrl({
      currentUrl: BASE_URL,
      roomId: ROOM_ID,
      roomKey: ROOM_KEY,
    });
    const parsed = new URL(url);

    // The request line, the query string, and the path are all key-free; only
    // the fragment holds it, and fragments are never sent in an HTTP request or
    // in a `Referer` header.
    expect(requestVisiblePart(url)).not.toContain(ROOM_KEY);
    expect(parsed.search).not.toContain(ROOM_KEY);
    expect(parsed.pathname).not.toContain(ROOM_KEY);
    expect(parsed.hash).toContain(ROOM_KEY);
  });

  it("builds a usable-looking but key-free link when there is no key", () => {
    const url = buildRoomInviteUrl({
      currentUrl: BASE_URL,
      roomId: ROOM_ID,
      roomKey: null,
    });
    expect(url).toBe(
      `https://drawstuff.example/editor?${COLLABORATION_ROOM_PARAM}=${ROOM_ID}`,
    );
    expect(roomKeyHash(null)).toBe("");
  });

  it("round-trips every generated key through the fragment", () => {
    for (let index = 0; index < 32; index += 1) {
      const key = generateRoomKey();
      expect(readRoomKeyFromHash(roomKeyHash(key))).toBe(key);
    }
  });

  it("reads the key from a fragment that carries other entries", () => {
    expect(
      readRoomKeyFromHash(
        `#zoom=2&${COLLABORATION_ROOM_KEY_FRAGMENT}=${ROOM_KEY}&x=1`,
      ),
    ).toBe(ROOM_KEY);
    // A leading "#" is optional: `location.hash` includes it, tests may not.
    expect(
      readRoomKeyFromHash(`${COLLABORATION_ROOM_KEY_FRAGMENT}=${ROOM_KEY}`),
    ).toBe(ROOM_KEY);
  });

  it("treats a missing or malformed key as no key at all", () => {
    // No silent downgrade: an unusable key must read as absent so the caller
    // reports an incomplete link instead of opening a session that can never
    // decrypt anything.
    expect(readRoomKeyFromHash("")).toBeNull();
    expect(readRoomKeyFromHash("#zoom=2")).toBeNull();
    expect(
      readRoomKeyFromHash(`#${COLLABORATION_ROOM_KEY_FRAGMENT}=`),
    ).toBeNull();
    expect(
      readRoomKeyFromHash(`#${COLLABORATION_ROOM_KEY_FRAGMENT}=too-short`),
    ).toBeNull();
    expect(
      readRoomKeyFromHash(
        `#${COLLABORATION_ROOM_KEY_FRAGMENT}=${ROOM_KEY.slice(0, -1)}+`,
      ),
    ).toBeNull();
  });
});
