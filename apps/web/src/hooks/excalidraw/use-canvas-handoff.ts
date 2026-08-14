"use client";

import { useCallback, useEffect, useRef } from "react";

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { useSceneSession } from "@/hooks/scene-session-context";

/** How a canvas handoff ended; the caller maps these onto its own status. */
export type CanvasHandoffOutcome =
  /** The canvas is now empty, unclaimed by any scene, and the room's to fill. */
  | "prepared"
  /** The user chose to keep their canvas; nothing was touched. */
  | "declined"
  /** The user asked to save first and the save failed; nothing was cleared. */
  | "save-failed"
  /** The caller was torn down mid-flow; state must not be touched. */
  | "torn-down";

/**
 * Owns the canvas side of joining a collaboration room: resolving unsaved local
 * work through the editor's existing save/discard/cancel prompt, then clearing
 * the scene session and the canvas so the room's baseline can replace it.
 *
 * Extracted from the room hook so the room hook receives one
 * `prepareCanvasForRoom` callback instead of a six-callback bag
 * (prompt/resolve/close/save/clear) it only ever used in this one sequence.
 * The editor owns all of those pieces anyway; the room hook only needs the
 * outcome.
 *
 * Clearing drops this client's `currentSceneId`, so a later save creates the
 * guest's own scene instead of overwriting the room owner's. It also releases
 * any previous canvas claim, which is why the room's claim comes after it.
 */
export function useCanvasHandoff(options: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** True when the canvas holds work that would be lost by joining. */
  hasLocalContent: () => boolean;
  /** The editor's existing three-way prompt for replacing the canvas. */
  requestSceneChangeDecision: () => Promise<"save" | "switch" | "cancel">;
  /** Settles a pending decision from outside the dialog; see cancel below. */
  resolveSceneChangeDecision: (choice: "save" | "switch" | "cancel") => void;
  closeSceneChangeConfirm: () => void;
  /** Saves the current canvas to the cloud; false means the save failed. */
  uploadSceneToCloud: (opts?: {
    suppressSuccessToast?: boolean;
  }) => Promise<boolean>;
  /** Drops the local scene session (id, revision, dirty state). */
  clearCurrentScene: () => void;
}): {
  prepareCanvasForRoom: (params: {
    /** Consulted after every await, so a torn-down caller stops the flow. */
    isCancelled: () => boolean;
    /** The user is about to be prompted; the caller may surface a status. */
    onDecisionPrompt: () => void;
  }) => Promise<CanvasHandoffOutcome>;
  /**
   * Resolves a still-open prompt as "cancel" and closes it. For the caller's
   * teardown: a join torn down while the user was still deciding must not
   * strand the dialog — nothing else would resolve the pending promise or
   * close it, and "cancel" is the answer that keeps their canvas untouched.
   */
  cancelPendingCanvasDecision: () => void;
} {
  const { suppressDirtyTracking, resumeDirtyTracking } = useSceneSession();

  // Read at call time, not captured: a re-created editor callback must not
  // change the identity of what the room hook holds.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /** True while the three-way prompt is awaiting the user's decision. */
  const pendingDecisionRef = useRef(false);

  const prepareCanvasForRoom = useCallback(
    async (params: {
      isCancelled: () => boolean;
      onDecisionPrompt: () => void;
    }): Promise<CanvasHandoffOutcome> => {
      const editor = optionsRef.current;
      if (editor.hasLocalContent()) {
        params.onDecisionPrompt();
        pendingDecisionRef.current = true;
        let decision: "save" | "switch" | "cancel";
        try {
          decision = await editor.requestSceneChangeDecision();
        } finally {
          pendingDecisionRef.current = false;
        }
        if (params.isCancelled()) return "torn-down";
        if (decision === "cancel") return "declined";
        if (decision === "save") {
          const saved = await optionsRef.current.uploadSceneToCloud({
            suppressSuccessToast: true,
          });
          if (params.isCancelled()) return "torn-down";
          if (!saved) return "save-failed";
        }
        optionsRef.current.closeSceneChangeConfirm();
      }
      const current = optionsRef.current;
      if (!current.excalidrawAPI) return "torn-down";
      // Remote-owned content is about to replace the canvas; the clear itself
      // must not mark the scene dirty.
      suppressDirtyTracking();
      try {
        current.clearCurrentScene();
        current.excalidrawAPI.updateScene({ elements: [] });
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
      return "prepared";
    },
    [suppressDirtyTracking, resumeDirtyTracking],
  );

  const cancelPendingCanvasDecision = useCallback(() => {
    if (!pendingDecisionRef.current) return;
    pendingDecisionRef.current = false;
    optionsRef.current.resolveSceneChangeDecision("cancel");
    optionsRef.current.closeSceneChangeConfirm();
  }, []);

  return { prepareCanvasForRoom, cancelPendingCanvasDecision };
}
