"use client";

/**
 * A canvas edited while signed out belongs to no cloud scene. Being signed out
 * — explicitly or through a session that silently lapsed — detaches the canvas
 * from its scene and marks it as a signed-out draft. Signing back in with a
 * non-empty draft asks once to save it as a new scene or discard it, so a
 * signed-in canvas is never silently attached to a scene it did not come from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  hasSignedOutDraftMarker,
  importFromLocalStorage,
  setSignedOutDraftMarker,
} from "@/data/local-storage";
import { getEditorStorageMode } from "@/lib/editor-storage-mode";

/** `unknown` covers a pending session and a failed (non-401) session fetch. */
export type AuthState = "unknown" | "signed-out" | "signed-in";

export type SignedOutDraftAction = "none" | "detach" | "prompt" | "settle";

export function resolveSignedOutDraftAction(input: {
  authState: AuthState;
  hasMarker: boolean;
  currentSceneId: string | undefined;
  hasContent: () => boolean;
}): SignedOutDraftAction {
  if (input.authState === "unknown") return "none";
  if (input.authState === "signed-out") return "detach";
  if (!input.hasMarker) return "none";
  return !input.currentSceneId && input.hasContent() ? "prompt" : "settle";
}

export function useSignedOutDraft(options: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  authState: AuthState;
  isRoomMode: boolean;
  hasCurrentCanvasContent: () => boolean;
}) {
  const { excalidrawAPI, authState, isRoomMode, hasCurrentCanvasContent } =
    options;
  const {
    currentSceneId,
    isSessionReady,
    clearCurrentScene,
    suppressDirtyTracking,
    resumeDirtyTracking,
  } = useSceneSession();
  const [needsDecision, setNeedsDecision] = useState(false);
  // One decision per signed-in stretch; being signed out re-arms it.
  const decidedRef = useRef(false);

  useEffect(() => {
    if (!excalidrawAPI || !isSessionReady || isRoomMode) return;
    if (getEditorStorageMode() !== "personal") return;
    if (authState === "signed-in" && decidedRef.current) return;

    const action = resolveSignedOutDraftAction({
      authState,
      hasMarker: hasSignedOutDraftMarker(),
      currentSceneId,
      // The canvas may not have applied its initial data yet on first load;
      // the persisted copy is what it is restoring from.
      hasContent: () =>
        hasCurrentCanvasContent() ||
        importFromLocalStorage().elements.length > 0,
    });
    if (action === "none") return;
    if (action === "detach") {
      decidedRef.current = false;
      // Saving needs a session; the kept marker asks again on next sign-in.
      setNeedsDecision(false);
      setSignedOutDraftMarker(true);
      if (currentSceneId) clearCurrentScene();
      return;
    }
    decidedRef.current = true;
    if (action === "prompt") setNeedsDecision(true);
    else setSignedOutDraftMarker(false);
  }, [
    excalidrawAPI,
    isSessionReady,
    isRoomMode,
    authState,
    currentSceneId,
    clearCurrentScene,
    hasCurrentCanvasContent,
  ]);

  // Saving binds the canvas to its new scene; that is the decision made.
  useEffect(() => {
    if (!needsDecision || !currentSceneId) return;
    setSignedOutDraftMarker(false);
    setNeedsDecision(false);
  }, [needsDecision, currentSceneId]);

  const discardSignedOutDraft = useCallback(() => {
    // Hold dirty tracking across resetScene's synchronous change event.
    suppressDirtyTracking();
    excalidrawAPI?.resetScene();
    requestAnimationFrame(() => resumeDirtyTracking());
    setSignedOutDraftMarker(false);
    setNeedsDecision(false);
  }, [excalidrawAPI, suppressDirtyTracking, resumeDirtyTracking]);

  return { needsDecision, discardSignedOutDraft };
}
