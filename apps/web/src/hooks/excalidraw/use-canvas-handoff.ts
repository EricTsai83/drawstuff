"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAppI18n } from "@/hooks/use-app-i18n";

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
  /** Ends this flow even while its save is in flight. */
  cancelSceneChangeDialog: () => void;
  setSceneChangeLoading: (loading: boolean) => void;
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
   * Cancels the confirmation/save flow, clears loading and closes its dialog.
   * An upload already in flight may finish, but cannot prepare the canvas or
   * continue this join after teardown.
   */
  cancelPendingCanvasDecision: () => void;
} {
  const { t } = useAppI18n();
  const {
    suppressDirtyTracking,
    resumeDirtyTracking,
    getCurrentSceneIdentity,
    getCanvasSaveGeneration,
  } = useSceneSession();

  // Read at call time, not captured: a re-created editor callback must not
  // change the identity of what the room hook holds.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const saveInFlightRef = useRef(false);
  const activeHandoffRef = useRef<{ cancelled: boolean } | null>(null);

  const prepareCanvasForRoom = useCallback(
    async (params: {
      isCancelled: () => boolean;
      keepCanvas?: boolean;
      skipPrompt?: boolean;
      onDecisionPrompt: () => void;
    }): Promise<CanvasHandoffOutcome> => {
      if (params.isCancelled()) return "torn-down";
      const editor = optionsRef.current;
      if (
        !params.keepCanvas &&
        !params.skipPrompt &&
        editor.hasLocalContent()
      ) {
        params.onDecisionPrompt();
        if (activeHandoffRef.current) {
          activeHandoffRef.current.cancelled = true;
          optionsRef.current.cancelSceneChangeDialog();
        }
        const attempt = { cancelled: false };
        activeHandoffRef.current = attempt;
        const isCancelled = () => params.isCancelled() || attempt.cancelled;
        try {
          while (true) {
            const decision =
              await optionsRef.current.requestSceneChangeDecision();
            if (isCancelled()) return "torn-down";
            if (decision === "cancel") return "declined";
            if (decision === "switch") break;
            if (saveInFlightRef.current) {
              toast.info(t("collaboration.saveStillInProgress"));
              continue;
            }
            saveInFlightRef.current = true;
            optionsRef.current.setSceneChangeLoading(true);
            let saved = false;
            try {
              saved = await optionsRef.current.uploadSceneToCloud({
                suppressSuccessToast: true,
              });
            } catch (error) {
              console.error("Failed to save before joining the room:", error);
            } finally {
              saveInFlightRef.current = false;
              if (activeHandoffRef.current === attempt)
                optionsRef.current.setSceneChangeLoading(false);
            }
            if (isCancelled()) return "torn-down";
            if (saved) break;
            // The previous choice was consumed; keep the same join waiting
            // for a retry, discard or cancel rather than abandoning the dialog.
          }
        } finally {
          if (activeHandoffRef.current === attempt) {
            activeHandoffRef.current = null;
            optionsRef.current.cancelSceneChangeDialog();
          }
        }
      }
      const current = optionsRef.current;
      if (params.isCancelled() || !current.excalidrawAPI) return "torn-down";
      // Remote-owned content is about to replace the canvas; the clear itself
      // must not mark the scene dirty.
      suppressDirtyTracking();
      try {
        preservePersonalDraft(
          current.excalidrawAPI,
          current.cancelPendingSceneSave,
          getCurrentSceneIdentity(),
          getCanvasSaveGeneration(),
        );
        if (!params.keepCanvas) {
          // resetScene() restores Excalidraw's default (editable) view mode,
          // and Excalidraw only re-applies the viewModeEnabled prop when it
          // changes, so a viewer whose prop stays true would become editable.
          const { viewModeEnabled } = current.excalidrawAPI.getAppState();
          current.excalidrawAPI.resetScene();
          current.excalidrawAPI.updateScene({ appState: { viewModeEnabled } });
        }
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
      return "prepared";
    },
    [
      suppressDirtyTracking,
      resumeDirtyTracking,
      getCurrentSceneIdentity,
      getCanvasSaveGeneration,
      t,
    ],
  );

  const cancelPendingCanvasDecision = useCallback(() => {
    const attempt = activeHandoffRef.current;
    if (!attempt) return;
    attempt.cancelled = true;
    activeHandoffRef.current = null;
    optionsRef.current.cancelSceneChangeDialog();
  }, []);

  useEffect(
    () => () => cancelPendingCanvasDecision(),
    [cancelPendingCanvasDecision],
  );

  return { prepareCanvasForRoom, cancelPendingCanvasDecision };
}
