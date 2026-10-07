"use client";

import { useCallback, useEffect, useRef } from "react";

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { preservePersonalDraft } from "@/lib/collab/personal-draft";
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

/** Preserve the personal draft and pause all cache writers before a room handoff. */
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
  cancelPendingSceneSave: () => void;
}): {
  prepareCanvasForRoom: (params: {
    /** Consulted after every await, so a torn-down caller stops the flow. */
    isCancelled: () => boolean;
    keepCanvas?: boolean;
    skipPrompt?: boolean;
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
  const {
    suppressDirtyTracking,
    resumeDirtyTracking,
    getCurrentSceneIdentity,
  } = useSceneSession();

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
      keepCanvas?: boolean;
      skipPrompt?: boolean;
      onDecisionPrompt: () => void;
    }): Promise<CanvasHandoffOutcome> => {
      const editor = optionsRef.current;
      if (
        !params.keepCanvas &&
        !params.skipPrompt &&
        editor.hasLocalContent()
      ) {
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
        preservePersonalDraft(
          current.excalidrawAPI,
          current.cancelPendingSceneSave,
          getCurrentSceneIdentity(),
        );
        if (!params.keepCanvas) current.excalidrawAPI.resetScene();
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
      return "prepared";
    },
    [suppressDirtyTracking, resumeDirtyTracking, getCurrentSceneIdentity],
  );

  const cancelPendingCanvasDecision = useCallback(() => {
    if (!pendingDecisionRef.current) return;
    pendingDecisionRef.current = false;
    optionsRef.current.resolveSceneChangeDecision("cancel");
    optionsRef.current.closeSceneChangeConfirm();
  }, []);

  return { prepareCanvasForRoom, cancelPendingCanvasDecision };
}
