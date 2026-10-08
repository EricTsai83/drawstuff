"use client";

/**
 * A canvas edited while signed out belongs to no cloud scene. Being signed out
 * — explicitly or through a session that silently lapsed — detaches the canvas
 * from its scene and marks it as a signed-out draft, remembering the scene's
 * name and which elements it held. Signing back in with a non-empty draft asks
 * once to save it as a new scene, keep editing it unsaved, or discard it, so a
 * signed-in canvas is never silently attached to a scene it did not come from.
 *
 * The draft is identified by its elements, not its editable name: renaming
 * keeps it, while clearing the canvas or loading another file leaves none of
 * those elements and resolves it (a kept decision included).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  importFromLocalStorage,
  readSignedOutDraftMarker,
  writeSignedOutDraftMarker,
  type SignedOutDraftMarker,
} from "@/data/local-storage";
import { getEditorStorageMode } from "@/lib/editor-storage-mode";

/** `unknown` covers a pending session and a failed (non-401) session fetch. */
export type AuthState = "unknown" | "signed-out" | "signed-in";

export type SignedOutDraftAction = "none" | "detach" | "prompt" | "settle";

type CanvasElement = { readonly id: string; readonly isDeleted?: boolean };

const NEW_DRAFT: SignedOutDraftMarker = {
  detachedFrom: null,
  kept: false,
  elementIds: [],
};

export function resolveSignedOutDraftAction(input: {
  authState: AuthState;
  marker: SignedOutDraftMarker | null;
  currentSceneId: string | undefined;
  hasContent: () => boolean;
}): SignedOutDraftAction {
  if (input.authState === "unknown") return "none";
  if (input.authState === "signed-out") return "detach";
  if (!input.marker) return "none";
  // Saved as, or replaced by, a cloud scene: the draft is resolved.
  if (input.currentSceneId) return "settle";
  if (input.marker.kept) return "none";
  return input.hasContent() ? "prompt" : "settle";
}

/** The marker a detach leaves; a fresh detach from a scene starts over. */
export function detachedMarker(
  previous: SignedOutDraftMarker | null,
  boundScene: { id: string | undefined; name: string; elementIds: string[] },
): SignedOutDraftMarker {
  if (boundScene.id)
    return {
      detachedFrom: boundScene.name.trim() || null,
      kept: false,
      elementIds: boundScene.elementIds,
    };
  return previous ?? NEW_DRAFT;
}

/**
 * Whether the canvas is still the detached draft: `same` while any of its
 * elements remain, `replaced` once a non-empty canvas holds none of them.
 * An empty canvas is undecided — it is either cleared or not yet restored.
 */
export function compareDraftLineage(
  elementIds: ReadonlySet<string>,
  elements: readonly CanvasElement[],
): "same" | "replaced" | "empty" {
  let hasLive = false;
  for (const element of elements) {
    if (element.isDeleted) continue;
    if (elementIds.has(element.id)) return "same";
    hasLive = true;
  }
  return hasLive ? "replaced" : "empty";
}

/**
 * Name and elements of the canvas being detached. A canvas showing content is
 * live and authoritative; an empty one may still be restoring on first load,
 * so the persisted copy it is restoring from is used instead.
 */
function captureDraftOrigin(api: ExcalidrawImperativeAPI): {
  name: string;
  elementIds: string[];
} {
  const live = api.getSceneElements();
  if (live.length > 0)
    return {
      name: api.getAppState().name ?? "",
      elementIds: live.map((element) => element.id),
    };
  const persisted = importFromLocalStorage();
  return {
    name: persisted.appState?.name ?? "",
    elementIds: persisted.elements.map((element) => element.id),
  };
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
  // Mirrors localStorage; read after mount so server and client render alike.
  const [marker, setMarker] = useState<SignedOutDraftMarker | null>(null);
  const [lineage, setLineage] = useState<"same" | "empty">("same");
  // Canvas changes arrive far more often than renders; read these from refs.
  const authStateRef = useRef(authState);
  const isRoomModeRef = useRef(isRoomMode);
  useEffect(() => {
    authStateRef.current = authState;
    isRoomModeRef.current = isRoomMode;
  }, [authState, isRoomMode]);

  const updateMarker = useCallback((next: SignedOutDraftMarker | null) => {
    writeSignedOutDraftMarker(next);
    setMarker(next);
    setLineage("same");
  }, []);

  useEffect(() => {
    if (!excalidrawAPI || !isSessionReady || isRoomMode) return;
    if (getEditorStorageMode() !== "personal") return;

    const stored = readSignedOutDraftMarker();
    const action = resolveSignedOutDraftAction({
      authState,
      marker: stored,
      currentSceneId,
      // The canvas may not have applied its initial data yet on first load;
      // the persisted copy is what it is restoring from.
      hasContent: () =>
        hasCurrentCanvasContent() ||
        importFromLocalStorage().elements.length > 0,
    });
    if (action === "detach") {
      // Saving needs a session; the kept marker asks again on next sign-in.
      setNeedsDecision(false);
      updateMarker(
        detachedMarker(stored, {
          id: currentSceneId,
          ...captureDraftOrigin(excalidrawAPI),
        }),
      );
      if (currentSceneId) clearCurrentScene();
      return;
    }
    if (action === "settle") {
      setNeedsDecision(false);
      updateMarker(null);
      return;
    }
    setMarker(stored);
    if (action === "prompt") setNeedsDecision(true);
  }, [
    excalidrawAPI,
    isSessionReady,
    isRoomMode,
    authState,
    currentSceneId,
    clearCurrentScene,
    hasCurrentCanvasContent,
    updateMarker,
  ]);

  const draftElementIds = useMemo(
    () => new Set(marker?.elementIds ?? []),
    [marker],
  );

  /** Call with every personal canvas change to notice the draft being replaced. */
  const observeCanvas = useCallback(
    (elements: readonly CanvasElement[]) => {
      if (draftElementIds.size === 0 || isRoomModeRef.current) return;
      if (getEditorStorageMode() !== "personal") return;
      const result = compareDraftLineage(draftElementIds, elements);
      if (result !== "replaced") {
        setLineage(result);
        return;
      }
      // Another canvas took its place: the decision about the old draft no
      // longer applies. Edits made to the new one while signed out are a new
      // draft of their own, asked about on the next sign-in.
      setNeedsDecision(false);
      updateMarker(authStateRef.current === "signed-out" ? NEW_DRAFT : null);
    },
    [draftElementIds, updateMarker],
  );

  const keepSignedOutDraft = useCallback(() => {
    setNeedsDecision(false);
    updateMarker({ ...(marker ?? NEW_DRAFT), kept: true });
  }, [marker, updateMarker]);

  const discardSignedOutDraft = useCallback(() => {
    // Hold dirty tracking across resetScene's synchronous change event.
    suppressDirtyTracking();
    excalidrawAPI?.resetScene();
    requestAnimationFrame(() => resumeDirtyTracking());
    setNeedsDecision(false);
    updateMarker(null);
  }, [excalidrawAPI, suppressDirtyTracking, resumeDirtyTracking, updateMarker]);

  return {
    needsDecision,
    /** Scene the unresolved draft was detached from, for the prompt and label. */
    detachedFromSceneName:
      !isRoomMode && !currentSceneId && lineage === "same"
        ? (marker?.detachedFrom ?? null)
        : null,
    observeCanvas,
    keepSignedOutDraft,
    discardSignedOutDraft,
  };
}
