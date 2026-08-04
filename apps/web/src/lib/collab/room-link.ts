import {
  roomKeySchema,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";

/**
 * Shape of a collaboration invitation link.
 *
 * The split is the whole point. The room id is a locator the backend already
 * knows, so it travels as a query parameter. The room key is the secret that
 * makes the room readable, so it travels only in the URL fragment:
 *
 * - Fragments are not part of an HTTP request, so the key never reaches the
 *   Next.js server, a CDN access log, or a server-side error report.
 * - Fragments are stripped from `Referer`, so following a link out of the
 *   editor cannot leak the key to a third-party origin.
 * - Nothing here ever writes the key into a tRPC input, so it cannot reach the
 *   database, the relay, or analytics either.
 *
 * The only way a key leaves this module is back into `location.hash`, and the
 * only way it is applied is `history.replaceState`, which does not issue a
 * request.
 */

export const COLLABORATION_ROOM_PARAM = "collab-room";
export const COLLABORATION_ROOM_KEY_FRAGMENT = "collab-key";

/**
 * Reads the room key out of a URL fragment (`#collab-key=…`). Returns `null`
 * for a missing or malformed key: an invalid key is treated as no key, so the
 * caller reports an incomplete link instead of attempting a session that could
 * never decrypt anything.
 */
export function readRoomKeyFromHash(hash: string): RoomKey | null {
  const raw = new URLSearchParams(
    hash.startsWith("#") ? hash.slice(1) : hash,
  ).get(COLLABORATION_ROOM_KEY_FRAGMENT);
  if (raw === null) return null;
  const parsed = roomKeySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Serializes a room key into fragment form, or `""` to clear the fragment. */
export function roomKeyHash(roomKey: RoomKey | null): string {
  if (!roomKey) return "";
  return `#${COLLABORATION_ROOM_KEY_FRAGMENT}=${roomKey}`;
}

/**
 * Builds the shareable invitation link: room id in the query string, room key
 * in the fragment. Any pre-existing query and fragment on `currentUrl` are
 * dropped so an unrelated parameter cannot ride along into the invitation.
 */
export function buildRoomInviteUrl(options: {
  currentUrl: string;
  roomId: string;
  roomKey: RoomKey | null;
}): string {
  const url = new URL(options.currentUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set(COLLABORATION_ROOM_PARAM, options.roomId);
  return `${url.toString()}${roomKeyHash(options.roomKey)}`;
}
