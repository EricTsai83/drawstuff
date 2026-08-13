"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneIdToStorage,
  clearCurrentSceneSessionFromStorage,
  loadCurrentSceneRevisionFromStorage,
  saveCurrentSceneRevisionToStorage,
  clearCurrentSceneRevisionFromStorage,
  loadCurrentSceneDirtyFromStorage,
  saveCurrentSceneDirtyToStorage,
  loadCurrentSceneWorkspaceIdFromStorage,
  saveCurrentSceneWorkspaceIdToStorage,
} from "@/data/local-storage";

/** Safety-net timeout: auto-resumes dirty tracking if a caller forgets to
 *  call `resumeDirtyTracking()`. Placed at module level so it is never
 *  re-created on render. */
const SUPPRESS_SAFETY_NET_MS = 5_000;

type SceneSessionContextValue = {
  currentSceneId: string | undefined;
  currentWorkspaceId: string | undefined;
  lastSyncedRevision: number | undefined;
  isDirty: boolean;
  isSessionReady: boolean;
  syncCurrentScene: (params: {
    id: string;
    revision?: number;
    workspaceId?: string;
  }) => void;
  clearCurrentScene: () => void;
  reloadSceneSession: () => void;
  markCurrentSceneDirty: () => void;
  markCurrentSceneClean: () => void;
  /** Update only the synced revision without touching dirty state.
   *  Useful after operations that bump the server revision without
   *  changing scene content (e.g. rename). */
  updateLastSyncedRevision: (revision: number) => void;
  /** Update only the workspace ID without touching dirty state.
   *  Useful when a scene is moved to another workspace from the dashboard. */
  updateCurrentWorkspaceId: (workspaceId: string) => void;
  /** Suppress dirty tracking. Call resumeDirtyTracking() when the operation
   *  is done. A time-based safety net (default 5s) auto-resumes if the
   *  caller forgets. */
  suppressDirtyTracking: (safetyNetMs?: number) => void;
  resumeDirtyTracking: () => void;
  shouldSuppressDirtyTracking: () => boolean;
  registerCanvasLifecycle: (lifecycle: CanvasLifecycle) => () => void;
  isCanvasCollaborationActive: () => boolean;
  resetCanvasAfterWorkspaceDeletion: () => void;
};

type CanvasLifecycle = {
  isCollaborationActive: () => boolean;
  resetAfterWorkspaceDeletion: () => void;
};

const SceneSessionContext = createContext<SceneSessionContextValue | null>(
  null,
);

export function SceneSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [currentSceneId, setCurrentSceneId] = useState<string | undefined>(() =>
    loadCurrentSceneIdFromStorage(),
  );
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<
    string | undefined
  >(() => loadCurrentSceneWorkspaceIdFromStorage());
  const [lastSyncedRevision, setLastSyncedRevision] = useState<
    number | undefined
  >(() => loadCurrentSceneRevisionFromStorage());
  const [isDirty, setIsDirty] = useState<boolean>(() =>
    loadCurrentSceneDirtyFromStorage(),
  );
  // Mirror of isDirty readable synchronously without triggering re-renders.
  // Used to skip redundant localStorage writes on the high-frequency onChange path.
  const isDirtyRef = useRef(isDirty);
  const [isSessionReady, setIsSessionReady] = useState(false);
  // Dirty-tracking suppression is reference-counted: independent suppressors
  // overlap (a collaboration write and a remote-scene apply can hold windows in
  // the same frame), so a resume releases exactly one hold instead of clearing
  // the flag out from under the others. Each entry is the hold's own safety-net
  // timer, so a caller that forgets to resume leaks nothing past the timeout;
  // the array's length is the live hold count.
  const suppressTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const canvasLifecycleRef = useRef<CanvasLifecycle | null>(null);

  const doSuppress = useCallback(
    (safetyNetMs: number = SUPPRESS_SAFETY_NET_MS) => {
      const timer = setTimeout(() => {
        const timers = suppressTimersRef.current;
        const index = timers.indexOf(timer);
        if (index !== -1) timers.splice(index, 1);
      }, safetyNetMs);
      suppressTimersRef.current.push(timer);
    },
    [],
  );

  const doResume = useCallback(() => {
    // Windows nest (a synchronous presence window opens and closes inside a
    // frame-deferred element window), so a resume releases the *newest* hold.
    // Releasing the oldest would hand a leaked outer hold an ever-newer safety
    // timer: continuous presence churn keeps replacing the surviving timer, and
    // the leak never expires. An unmatched resume finds nothing and is a no-op.
    const timer = suppressTimersRef.current.pop();
    if (timer !== undefined) clearTimeout(timer);
  }, []);

  const syncCurrentScene = useCallback(
    ({
      id,
      revision,
      workspaceId,
    }: {
      id: string;
      revision?: number;
      workspaceId?: string;
    }) => {
      setCurrentSceneId(id);
      setLastSyncedRevision(revision);
      if (workspaceId !== undefined) {
        setCurrentWorkspaceId(workspaceId);
      }
      setIsDirty(false);
      isDirtyRef.current = false;
      try {
        saveCurrentSceneIdToStorage(id);
        if (revision !== undefined) {
          saveCurrentSceneRevisionToStorage(revision);
        } else {
          clearCurrentSceneRevisionFromStorage();
        }
        if (workspaceId !== undefined) {
          saveCurrentSceneWorkspaceIdToStorage(workspaceId);
        }
        saveCurrentSceneDirtyToStorage(false);
      } catch {
        // ignore storage errors
      }
    },
    [],
  );

  const clearCurrentScene = useCallback(() => {
    setCurrentSceneId(undefined);
    setCurrentWorkspaceId(undefined);
    setLastSyncedRevision(undefined);
    setIsDirty(false);
    isDirtyRef.current = false;
    // Deliberately does not release suppression holds: callers that suppress
    // around this (joining a room clears the scene inside its own window) own
    // their hold, and a leaked hold self-releases via its safety-net timer.
    try {
      clearCurrentSceneSessionFromStorage();
    } catch {
      // ignore storage errors
    }
  }, []);

  const reloadSceneSession = useCallback(() => {
    try {
      const dirty = loadCurrentSceneDirtyFromStorage();
      setCurrentSceneId(loadCurrentSceneIdFromStorage());
      setCurrentWorkspaceId(loadCurrentSceneWorkspaceIdFromStorage());
      setLastSyncedRevision(loadCurrentSceneRevisionFromStorage());
      setIsDirty(dirty);
      isDirtyRef.current = dirty;
    } catch {
      setCurrentSceneId(undefined);
      setCurrentWorkspaceId(undefined);
      setLastSyncedRevision(undefined);
      setIsDirty(false);
      isDirtyRef.current = false;
    }
    setIsSessionReady(true);
  }, []);

  const markCurrentSceneDirty = useCallback(() => {
    // Skip if already dirty — avoids redundant localStorage.setItem calls
    // on the high-frequency Excalidraw onChange path.
    if (isDirtyRef.current) return;
    isDirtyRef.current = true;
    setIsDirty(true);
    try {
      saveCurrentSceneDirtyToStorage(true);
    } catch {
      // ignore storage errors
    }
  }, []);

  const markCurrentSceneClean = useCallback(() => {
    if (!isDirtyRef.current) return;
    isDirtyRef.current = false;
    setIsDirty(false);
    try {
      saveCurrentSceneDirtyToStorage(false);
    } catch {
      // ignore storage errors
    }
  }, []);

  const updateLastSyncedRevision = useCallback((revision: number) => {
    setLastSyncedRevision(revision);
    try {
      saveCurrentSceneRevisionToStorage(revision);
    } catch {
      // ignore storage errors
    }
  }, []);

  const updateCurrentWorkspaceId = useCallback((workspaceId: string) => {
    setCurrentWorkspaceId(workspaceId);
    try {
      saveCurrentSceneWorkspaceIdToStorage(workspaceId);
    } catch {
      // ignore storage errors
    }
  }, []);

  const suppressDirtyTracking = useCallback(
    (safetyNetMs?: number) => {
      doSuppress(safetyNetMs);
    },
    [doSuppress],
  );

  const resumeDirtyTracking = useCallback(() => {
    doResume();
  }, [doResume]);

  const shouldSuppressDirtyTracking = useCallback(
    () => suppressTimersRef.current.length > 0,
    [],
  );

  const registerCanvasLifecycle = useCallback((lifecycle: CanvasLifecycle) => {
    canvasLifecycleRef.current = lifecycle;
    return () => {
      if (canvasLifecycleRef.current === lifecycle) {
        canvasLifecycleRef.current = null;
      }
    };
  }, []);

  const isCanvasCollaborationActive = useCallback(
    () => canvasLifecycleRef.current?.isCollaborationActive() ?? false,
    [],
  );

  const resetCanvasAfterWorkspaceDeletion = useCallback(() => {
    const reset = canvasLifecycleRef.current?.resetAfterWorkspaceDeletion;
    if (reset) {
      reset();
      return;
    }
    clearCurrentScene();
  }, [clearCurrentScene]);

  // Clean up the safety-net timers on unmount to avoid firing into a stale ref.
  useEffect(() => {
    const timers = suppressTimersRef.current;
    return () => {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    };
  }, []);

  const value = useMemo<SceneSessionContextValue>(
    () => ({
      currentSceneId,
      currentWorkspaceId,
      lastSyncedRevision,
      isDirty,
      isSessionReady,
      syncCurrentScene,
      clearCurrentScene,
      reloadSceneSession,
      markCurrentSceneDirty,
      markCurrentSceneClean,
      updateLastSyncedRevision,
      updateCurrentWorkspaceId,
      suppressDirtyTracking,
      resumeDirtyTracking,
      shouldSuppressDirtyTracking,
      registerCanvasLifecycle,
      isCanvasCollaborationActive,
      resetCanvasAfterWorkspaceDeletion,
    }),
    [
      currentSceneId,
      currentWorkspaceId,
      lastSyncedRevision,
      isDirty,
      isSessionReady,
      syncCurrentScene,
      clearCurrentScene,
      reloadSceneSession,
      markCurrentSceneDirty,
      markCurrentSceneClean,
      updateLastSyncedRevision,
      updateCurrentWorkspaceId,
      suppressDirtyTracking,
      resumeDirtyTracking,
      shouldSuppressDirtyTracking,
      registerCanvasLifecycle,
      isCanvasCollaborationActive,
      resetCanvasAfterWorkspaceDeletion,
    ],
  );

  return (
    <SceneSessionContext.Provider value={value}>
      {children}
    </SceneSessionContext.Provider>
  );
}

export function useSceneSession(): SceneSessionContextValue {
  const ctx = useContext(SceneSessionContext);
  if (!ctx) {
    throw new Error(
      "useSceneSession must be used within a SceneSessionProvider",
    );
  }
  return ctx;
}
