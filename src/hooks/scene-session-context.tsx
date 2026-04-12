"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneIdToStorage,
  clearCurrentSceneIdFromStorage,
  loadCurrentSceneRevisionFromStorage,
  saveCurrentSceneRevisionToStorage,
  clearCurrentSceneRevisionFromStorage,
  loadCurrentSceneDirtyFromStorage,
  saveCurrentSceneDirtyToStorage,
  clearCurrentSceneDirtyFromStorage,
} from "@/data/local-storage";

type SceneSessionContextValue = {
  currentSceneId: string | undefined;
  lastSyncedRevision: number | undefined;
  isDirty: boolean;
  isSessionReady: boolean;
  syncCurrentScene: (params: { id: string; revision?: number }) => void;
  clearCurrentScene: () => void;
  reloadSceneSession: () => void;
  markCurrentSceneDirty: () => void;
  markCurrentSceneClean: () => void;
  suppressDirtyTracking: (durationMs?: number) => void;
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
  const [lastSyncedRevision, setLastSyncedRevision] = useState<
    number | undefined
  >(() => loadCurrentSceneRevisionFromStorage());
  const [isDirty, setIsDirty] = useState<boolean>(() =>
    loadCurrentSceneDirtyFromStorage(),
  );
  const [isSessionReady, setIsSessionReady] = useState(false);
  const suppressDirtyTrackingUntilRef = useRef(0);

  const syncCurrentScene = useCallback(
    ({ id, revision }: { id: string; revision?: number }) => {
      setCurrentSceneId(id);
      setLastSyncedRevision(revision);
      setIsDirty(false);
      suppressDirtyTrackingUntilRef.current = Date.now() + 1200;
      try {
        saveCurrentSceneIdToStorage(id);
        if (revision !== undefined) {
          saveCurrentSceneRevisionToStorage(revision);
        } else {
          clearCurrentSceneRevisionFromStorage();
        }
        saveCurrentSceneDirtyToStorage(false);
      } catch {
        // ignore storage errors
      }
    },
    [suppressDirtyTrackingUntilRef],
  );

  const clearCurrentScene = useCallback(() => {
    setCurrentSceneId(undefined);
    setLastSyncedRevision(undefined);
    setIsDirty(false);
    suppressDirtyTrackingUntilRef.current = 0;
    try {
      clearCurrentSceneIdFromStorage();
      clearCurrentSceneRevisionFromStorage();
      clearCurrentSceneDirtyFromStorage();
    } catch {
      // ignore storage errors
    }
  }, [suppressDirtyTrackingUntilRef]);

  const reloadSceneSession = useCallback(() => {
    try {
      setCurrentSceneId(loadCurrentSceneIdFromStorage());
      setLastSyncedRevision(loadCurrentSceneRevisionFromStorage());
      setIsDirty(loadCurrentSceneDirtyFromStorage());
    } catch {
      setCurrentSceneId(undefined);
      setLastSyncedRevision(undefined);
      setIsDirty(false);
    }
    setIsSessionReady(true);
  }, []);

  const markCurrentSceneDirty = useCallback(() => {
    setIsDirty(true);
    try {
      saveCurrentSceneDirtyToStorage(true);
    } catch {
      // ignore storage errors
    }
  }, []);

  const markCurrentSceneClean = useCallback(() => {
    setIsDirty(false);
    try {
      saveCurrentSceneDirtyToStorage(false);
    } catch {
      // ignore storage errors
    }
  }, []);

  const suppressDirtyTracking = useCallback(
    (durationMs = 1200) => {
      suppressDirtyTrackingUntilRef.current = Date.now() + durationMs;
    },
    [suppressDirtyTrackingUntilRef],
  );

  const shouldSuppressDirtyTracking = useCallback(
    () => suppressDirtyTrackingUntilRef.current > Date.now(),
    [suppressDirtyTrackingUntilRef],
  );

  const value = useMemo<SceneSessionContextValue>(
    () => ({
      currentSceneId,
      lastSyncedRevision,
      isDirty,
      isSessionReady,
      syncCurrentScene,
      clearCurrentScene,
      reloadSceneSession,
      markCurrentSceneDirty,
      markCurrentSceneClean,
      suppressDirtyTracking,
      shouldSuppressDirtyTracking,
    }),
    [
      currentSceneId,
      lastSyncedRevision,
      isDirty,
      isSessionReady,
      syncCurrentScene,
      clearCurrentScene,
      reloadSceneSession,
      markCurrentSceneDirty,
      markCurrentSceneClean,
      suppressDirtyTracking,
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
