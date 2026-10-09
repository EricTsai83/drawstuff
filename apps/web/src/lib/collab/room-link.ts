import { roomIdSchema, type RoomId } from "@drawstuff/collaboration/protocol";

/**
 * Shape of a collaboration invitation link: the room id as a query parameter
 * and nothing else. Access is decided by the room for the signed-in account,
 * so the link is only a locator.
 */
export const COLLABORATION_ROOM_PARAM = "collab-room";

/** Fragment older links carried; ignored and stripped when seen. */
const LEGACY_ROOM_KEY_FRAGMENT = "collab-key";

/**
 * Builds the shareable invitation link. Any pre-existing query and fragment on
 * `currentUrl` are dropped so an unrelated parameter cannot ride along.
 */
export function buildRoomInviteUrl(options: {
  currentUrl: string;
  roomId: string;
}): string {
  const url = new URL(options.currentUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set(COLLABORATION_ROOM_PARAM, options.roomId);
  return url.toString();
}

/** Reads the room id from a URL's query string; `null` when absent or malformed. */
export function readRoomIdFromUrl(url: string | URL): RoomId | null {
  return (
    roomIdSchema.safeParse(
      new URL(url).searchParams.get(COLLABORATION_ROOM_PARAM),
    ).data ?? null
  );
}

/**
 * Removes an old `#collab-key=…` fragment from the address bar. Uses
 * `history.replaceState`, so no navigation or request happens.
 */
export function stripLegacyRoomKeyFragment(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has(LEGACY_ROOM_KEY_FRAGMENT)) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}
