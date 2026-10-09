"use client";

import { useEffect, useRef } from "react";
import type { AuthState } from "@/hooks/excalidraw/use-signed-out-draft";

/**
 * A room link opened while signed out cannot join, so its canvas stays
 * read-only. Open the collaboration dialog once per room so the person sees
 * why and can sign in, instead of a blank canvas without tools.
 */
export function useSignedOutRoomPrompt(options: {
  authState: AuthState;
  roomId: string | null;
  openDialog: () => void;
}): void {
  const { authState, roomId, openDialog } = options;
  const prompted = useRef<string | null>(null);
  useEffect(() => {
    if (authState !== "signed-out" || !roomId || prompted.current === roomId)
      return;
    prompted.current = roomId;
    openDialog();
  }, [authState, roomId, openDialog]);
}
