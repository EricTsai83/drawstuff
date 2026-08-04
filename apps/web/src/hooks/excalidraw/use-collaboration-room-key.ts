"use client";

import { useCallback, useEffect, useState } from "react";

import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";

import { readRoomKeyFromHash, roomKeyHash } from "@/lib/collab/room-link";

/**
 * Holds the room's end-to-end key in the URL fragment.
 *
 * The fragment is the storage: it survives a reload, it makes the link
 * shareable, and it is the only URL component that is never sent to a server.
 * The key is deliberately *not* mirrored into React Router state, localStorage,
 * or a query parameter — each of those would put it somewhere a request, a log,
 * or a backup could pick it up.
 *
 * Writes go through `history.replaceState`, which changes the address bar
 * without issuing a navigation, so updating the key never produces a request
 * that could carry it.
 *
 * This coexists with the `nuqs` query-state that owns the room id: its App
 * Router adapter rebuilds the URL as `origin + pathname + query + location.hash`
 * and reads the hash live when it flushes, so a queued room-id update preserves
 * whatever key is in the address bar. The reverse also holds — a write here uses
 * the current `location.search`, and any nuqs update still queued flushes
 * afterwards and restores its own query string.
 */
export function useCollaborationRoomKey(): [
  RoomKey | null,
  (next: RoomKey | null) => void,
] {
  const [roomKey, setRoomKeyState] = useState<RoomKey | null>(null);

  useEffect(() => {
    const read = (): void => {
      setRoomKeyState(readRoomKeyFromHash(window.location.hash));
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const setRoomKey = useCallback((next: RoomKey | null) => {
    setRoomKeyState(next);
    if (typeof window === "undefined") return;
    // replaceState, never assignment to location.hash: no navigation, no
    // history entry, and no request that could carry the key.
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${roomKeyHash(next)}`,
    );
  }, []);

  return [roomKey, setRoomKey];
}
