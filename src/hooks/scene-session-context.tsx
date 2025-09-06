"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneIdToStorage,
  clearCurrentSceneIdFromStorage,
} from "@/data/local-storage";

type SceneSessionContextValue = {
  currentSceneId: string | undefined;
  saveCurrentSceneId: (id: string) => void;
  clearCurrentSceneId: () => void;
  reloadCurrentSceneId: () => void;
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

  const saveCurrentSceneId = useCallback((id: string) => {
    setCurrentSceneId(id);
    try {
      saveCurrentSceneIdToStorage(id);
    } catch {
      // ignore storage errors
    }
  }, []);

  const clearCurrentSceneId = useCallback(() => {
    setCurrentSceneId(undefined);
    try {
      clearCurrentSceneIdFromStorage();
    } catch {
      // ignore storage errors
    }
  }, []);

  const reloadCurrentSceneId = useCallback(() => {
    try {
      setCurrentSceneId(loadCurrentSceneIdFromStorage());
    } catch {
      setCurrentSceneId(undefined);
    }
  }, []);

  const value = useMemo<SceneSessionContextValue>(
    () => ({
      currentSceneId,
      saveCurrentSceneId,
      clearCurrentSceneId,
      reloadCurrentSceneId,
    }),
    [
      currentSceneId,
      saveCurrentSceneId,
      clearCurrentSceneId,
      reloadCurrentSceneId,
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
