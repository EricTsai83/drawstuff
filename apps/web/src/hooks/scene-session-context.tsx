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
  clearCurrentSceneWorkspaceIdFromStorage,
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
  // Dirty-tracking suppression: a boolean flag is the primary mechanism;
  // a time-based expiry acts as a safety net so suppression never leaks.
  const suppressedRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSuppress = useCallback((safetyNetMs: number = SUPPRESS_SAFETY_NET_MS) => {
    suppressedRef.current = true;
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = setTimeout(() => {
      suppressedRef.current = false;
      suppressTimerRef.current = null;
    }, safetyNetMs);
  }, []);

  const doResume = useCallback(() => {
    suppressedRef.current = false;
    if (suppressTimerRef.current) {
      clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
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
    doResume();
    try {
      clearCurrentSceneSessionFromStorage();
    } catch {
      // ignore storage errors
    }
  }, [doResume]);

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
    () => suppressedRef.current,
    [],
  );

  // Clean up the safety-net timer on unmount to avoid firing into a stale ref.
  useEffect(() => {
    return () => {
      if (suppressTimerRef.current) {
        clearTimeout(suppressTimerRef.current);
      }
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
