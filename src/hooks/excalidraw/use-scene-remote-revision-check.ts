"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSceneSession } from "@/hooks/scene-session-context";
import { getSceneMetaBySceneId } from "@/lib/import-data-from-db";
import { resolveSceneSyncAction } from "@/lib/scene-sync";
import type { SceneConflictInfo } from "@/hooks/use-cloud-upload";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseSceneRemoteRevisionCheckParams = {
  applyRemoteScene: (params: {
    sceneId: string;
    getActiveTheme?: () => "dark" | "light";
  }) => Promise<
    | { ok: true; revision?: number }
    | { ok: false; reason: "scene_data_missing" | "incomplete_files" }
  >;
  uploadSceneToCloud: (opts?: {
    workspaceId?: string;
    suppressSuccessToast?: boolean;
    mode?: "create" | "update";
  }) => Promise<boolean>;
  getActiveTheme?: () => "dark" | "light";
  workspaceId?: string;
  /** Composite readiness: true only when excalidraw API is mounted AND session state is fresh. */
  isReady: boolean;
  isUploadInProgress: boolean;
  isBlockingDialogOpen: boolean;
  externalConflict: SceneConflictInfo | null;
  onExternalConflictHandled: () => void;
};

type ConflictChoice = "loadRemote" | "keepLocal" | "saveAsNew";

type PendingSceneConflict = {
  sceneId: string;
  remoteRevision?: number;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSceneRemoteRevisionCheck({
  applyRemoteScene,
  uploadSceneToCloud,
  getActiveTheme,
  workspaceId,
  isReady,
  isUploadInProgress,
  isBlockingDialogOpen,
  externalConflict,
  onExternalConflictHandled,
}: UseSceneRemoteRevisionCheckParams) {
  const { currentSceneId, lastSyncedRevision, isDirty } = useSceneSession();

  // ---- Conflict dialog state ------------------------------------------------
  const [pendingConflict, setPendingConflict] =
    useState<PendingSceneConflict | null>(null);
  const [isConflictLoading, setIsConflictLoading] = useState(false);
  const ignoredConflictKeyRef = useRef<string | undefined>(undefined);

  const conflictKey = useMemo(
    () =>
      pendingConflict
        ? buildConflictKey(pendingConflict.sceneId, pendingConflict.remoteRevision)
        : undefined,
    [pendingConflict],
  );

  const openConflict = useCallback((conflict: PendingSceneConflict) => {
    if (!conflict.sceneId) return;
    setPendingConflict(conflict);
  }, []);

  const clearConflict = useCallback(() => {
    setPendingConflict(null);
    setIsConflictLoading(false);
  }, []);

  // ---- Core check -----------------------------------------------------------
  const inFlightRef = useRef(false);
  const lastCheckAtRef = useRef(0);

  const checkRemoteRevision = useCallback(
    async ({ suppressToast = false }: { suppressToast?: boolean } = {}) => {
      if (!currentSceneId || !isReady) return;
      if (isUploadInProgress || isBlockingDialogOpen || pendingConflict) return;
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      lastCheckAtRef.current = Date.now();
      try {
        const remoteMeta = await getSceneMetaBySceneId(currentSceneId);
        if (!remoteMeta?.id) return;

        const action = resolveSceneSyncAction({
          localRevision: lastSyncedRevision,
          remoteRevision: remoteMeta.revision,
          isDirty,
        });

        if (action === "noop") return;

        if (action === "prompt_conflict") {
          const key = buildConflictKey(currentSceneId, remoteMeta.revision);
          if (ignoredConflictKeyRef.current !== key) {
            openConflict({
              sceneId: currentSceneId,
              remoteRevision: remoteMeta.revision,
            });
          }
          return;
        }

        // action === "refresh_remote"
        const result = await applyRemoteScene({
          sceneId: currentSceneId,
          getActiveTheme,
        });
        // With progressive loading the canvas is updated even when some image
        // assets are missing (reason: "incomplete_files"). Only treat
        // "scene_data_missing" as a true failure.
        const applied = result.ok || result.reason === "incomplete_files";
        if (applied) {
          ignoredConflictKeyRef.current = undefined;
          if (!suppressToast) {
            toast.success("Loaded the latest remote scene.");
          }
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      currentSceneId,
      isReady,
      isUploadInProgress,
      isBlockingDialogOpen,
      pendingConflict,
      isDirty,
      lastSyncedRevision,
      applyRemoteScene,
      getActiveTheme,
      openConflict,
    ],
  );

  // ---- Conflict choice handler ----------------------------------------------
  const handleConflictChoice = useCallback(
    async (choice: ConflictChoice) => {
      if (!pendingConflict) return;

      if (choice === "keepLocal") {
        ignoredConflictKeyRef.current = conflictKey;
        clearConflict();
        return;
      }

      setIsConflictLoading(true);
      try {
        if (choice === "loadRemote") {
          const result = await applyRemoteScene({
            sceneId: pendingConflict.sceneId,
            getActiveTheme,
          });
          const applied = result.ok || result.reason === "incomplete_files";
          if (applied) {
            ignoredConflictKeyRef.current = undefined;
            clearConflict();
          } else {
            toast.error("Failed to load the remote scene. Please try again.");
          }
          return;
        }

        // choice === "saveAsNew"
        const saved = await uploadSceneToCloud({
          mode: "create",
          workspaceId,
          suppressSuccessToast: true,
        });
        if (saved) {
          ignoredConflictKeyRef.current = undefined;
          clearConflict();
          toast.success("Saved local changes as a new scene.");
        }
      } finally {
        setIsConflictLoading(false);
      }
    },
    [
      pendingConflict,
      conflictKey,
      clearConflict,
      applyRemoteScene,
      getActiveTheme,
      uploadSceneToCloud,
      workspaceId,
    ],
  );

  // ---- Effects --------------------------------------------------------------

  // External conflict (from upload flow detecting a revision mismatch)
  useEffect(() => {
    if (!externalConflict) return;
    openConflict({
      sceneId: externalConflict.sceneId,
      remoteRevision: externalConflict.remoteRevision,
    });
    onExternalConflictHandled();
  }, [externalConflict, onExternalConflictHandled, openConflict]);

  // Initial check: runs exactly once per scene, only after isReady is true.
  // Keyed to currentSceneId so switching scenes triggers a fresh check.
  const lastInitialCheckSceneIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isReady || !currentSceneId) return;
    if (lastInitialCheckSceneIdRef.current === currentSceneId) return;
    lastInitialCheckSceneIdRef.current = currentSceneId;
    void checkRemoteRevision({ suppressToast: true });
  }, [isReady, currentSceneId, checkRemoteRevision]);

  // Stable ref so the focus/visibility listeners don't re-register on every
  // state change (checkRemoteRevision has many reactive dependencies).
  const checkRemoteRevisionRef = useRef(checkRemoteRevision);
  useEffect(() => {
    checkRemoteRevisionRef.current = checkRemoteRevision;
  }, [checkRemoteRevision]);

  // Focus / visibility checks (ongoing, debounced)
  useEffect(() => {
    if (!isReady) return;

    function debouncedCheck() {
      if (Date.now() - lastCheckAtRef.current < 750) return;
      void checkRemoteRevisionRef.current();
    }

    function handleFocus() {
      debouncedCheck();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") debouncedCheck();
    }

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isReady]);

  // ---- Return ---------------------------------------------------------------
  return {
    checkRemoteRevision,
    conflictDialog: {
      open: pendingConflict !== null,
      onOpenChange: (open: boolean) => {
        if (!open && !isConflictLoading) {
          clearConflict();
        }
      },
      onChoose: handleConflictChoice,
      isLoading: isConflictLoading,
    },
  } as const;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConflictKey(sceneId: string, remoteRevision?: number) {
  return `${sceneId}:${remoteRevision ?? "unknown"}`;
}
