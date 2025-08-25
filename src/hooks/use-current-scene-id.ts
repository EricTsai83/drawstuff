import { useState, useEffect, useCallback } from "react";
import {
  loadCurrentSceneIdFromStorage,
  saveCurrentSceneIdToStorage,
  clearCurrentSceneIdFromStorage,
} from "@/data/local-storage";

export function useCurrentSceneId() {
  const [currentSceneId, setCurrentSceneId] = useState<string | undefined>(
    undefined,
  );

  // 初始化從 localStorage 載入
  useEffect(() => {
    const stored = loadCurrentSceneIdFromStorage();
    setCurrentSceneId(stored);
  }, []);

  // 保存到 localStorage 並更新 state
  const saveCurrentSceneId = useCallback((id: string) => {
    saveCurrentSceneIdToStorage(id);
    setCurrentSceneId(id);
  }, []);

  // 清除 localStorage 並更新 state
  const clearCurrentSceneId = useCallback(() => {
    clearCurrentSceneIdFromStorage();
    setCurrentSceneId(undefined);
  }, []);

  // 從 localStorage 重新載入
  const reloadCurrentSceneId = useCallback(() => {
    const stored = loadCurrentSceneIdFromStorage();
    setCurrentSceneId(stored);
  }, []);

  return {
    currentSceneId,
    saveCurrentSceneId,
    clearCurrentSceneId,
    reloadCurrentSceneId,
  };
}
