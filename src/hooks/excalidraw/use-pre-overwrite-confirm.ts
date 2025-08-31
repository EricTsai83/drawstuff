"use client";

import { useCallback, useRef, useState } from "react";

export type SceneChangeDecision = "save" | "switch" | "cancel";

export type UseSceneChangeConfirm = {
  isSceneChangeDialogOpen: boolean;
  isSceneChangeDialogLoading: boolean;
  handleSceneChangeDialogOpenChange: (open: boolean) => void;
  requestSceneChangeDecision: () => Promise<SceneChangeDecision>;
  resolveSceneChangeDecision: (choice: SceneChangeDecision) => void;
  setSceneChangeDialogLoading: (loading: boolean) => void;
  closeSceneChangeDialog: () => void;
};

/**
 * 管理「儲存 / 覆蓋 / 取消」三選一對話框的狀態與流程。
 * - 以 Promise 形式提供 requestChoice，呼叫端可 await 使用者選擇。
 * - 當對話框被關閉（未選擇），視為 cancel。
 */
export function useSceneChangeConfirm(): UseSceneChangeConfirm {
  const [isSceneChangeDialogOpen, setIsSceneChangeDialogOpen] = useState(false);
  const [isSceneChangeDialogLoading, setIsSceneChangeDialogLoading] =
    useState(false);
  const resolverRef = useRef<((c: SceneChangeDecision) => void) | null>(null);

  const handleSceneChangeDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        if (isSceneChangeDialogLoading) {
          // 載入中禁止關閉
          return;
        }
        // 若使用者直接關閉視窗，視為取消
        resolverRef.current?.("cancel");
        resolverRef.current = null;
      }
      setIsSceneChangeDialogOpen(nextOpen);
    },
    [isSceneChangeDialogLoading],
  );

  const requestSceneChangeDecision =
    useCallback((): Promise<SceneChangeDecision> => {
      setIsSceneChangeDialogOpen(true);
      return new Promise<SceneChangeDecision>((resolve) => {
        resolverRef.current = resolve;
      });
    }, []);

  const resolveSceneChangeDecision = useCallback(
    (choice: SceneChangeDecision) => {
      resolverRef.current?.(choice);
      resolverRef.current = null;
      // 不立即關閉，交由呼叫端在需要時關閉（可搭配 loading）
    },
    [],
  );

  const setSceneChangeDialogLoading = useCallback((loading: boolean) => {
    setIsSceneChangeDialogLoading(loading);
  }, []);

  const closeSceneChangeDialog = useCallback(() => {
    if (isSceneChangeDialogLoading) return; // 載入中仍不可關閉
    setIsSceneChangeDialogOpen(false);
  }, [isSceneChangeDialogLoading]);

  return {
    isSceneChangeDialogOpen,
    isSceneChangeDialogLoading,
    handleSceneChangeDialogOpenChange,
    requestSceneChangeDecision,
    resolveSceneChangeDecision,
    setSceneChangeDialogLoading,
    closeSceneChangeDialog,
  } as const;
}
