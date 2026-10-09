"use client";

import { useEffect, useRef, useState } from "react";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
import { api } from "@/trpc/react";

/**
 * Room key custody in the editor (plan 19).
 *
 * - A room opened without its key (a bare `?collab-room=` URL, another
 *   device) asks Room for its custody copy once, before the paste-link
 *   fallback is offered.
 * - A room joined with a key from its link hands that key to Room once, so
 *   rooms created before custody become reopenable. Room accepts only the key
 *   the room was sealed with, and only from the owner, members and
 *   allowlisted emails; every other answer is ignored.
 */
export function useRoomKeyCustody(options: {
  roomId: string | null;
  roomKey: RoomKey | null;
  status: CollaborationRoomStatus;
  isAuthenticated: boolean;
  onRoomKeyChange: (roomKey: RoomKey) => void;
}): { lookupSettled: boolean } {
  const { roomId, roomKey, status, isAuthenticated, onRoomKeyChange } = options;
  const utils = api.useUtils();
  const lookedUp = useRef<string | null>(null);
  const [settledFor, setSettledFor] = useState<string | null>(null);
  /** Keys that came from custody or were already handed over: `roomId:key`. */
  const custodied = useRef(new Set<string>());

  useEffect(() => {
    if (!isAuthenticated || !roomId || roomKey) return;
    if (status !== "missing-room-key" || lookedUp.current === roomId) return;
    lookedUp.current = roomId;
    let current = true;
    let finished = false;
    void utils.client.collaborationAuthority.roomKey
      .mutate({ roomId: roomIdSchema.parse(roomId) })
      .then((found) => {
        if (!current || !found) return false;
        custodied.current.add(`${roomId}:${found.roomKey}`);
        onRoomKeyChange(found.roomKey);
        return true;
      })
      .catch(() => false)
      .then((found) => {
        finished = true;
        // A found key settles nothing: the room still reads as keyless until
        // it rejoins, and settling then would flash the paste-link dialog.
        if (current && !found) setSettledFor(roomId);
      });
    return () => {
      current = false;
      // An abandoned lookup has not answered; let the next attempt ask again.
      if (!finished && lookedUp.current === roomId) lookedUp.current = null;
    };
  }, [isAuthenticated, roomId, roomKey, status, utils, onRoomKeyChange]);

  useEffect(() => {
    if (!isAuthenticated || !roomId || !roomKey || status !== "connected")
      return;
    const entry = `${roomId}:${roomKey}`;
    if (custodied.current.has(entry)) return;
    custodied.current.add(entry);
    void utils.client.collaborationAuthority.escrowRoomKey
      .mutate({ roomId: roomIdSchema.parse(roomId), roomKey })
      .catch(() => undefined);
  }, [isAuthenticated, roomId, roomKey, status, utils]);

  return {
    lookupSettled: status === "missing-room-key" && settledFor === roomId,
  };
}
