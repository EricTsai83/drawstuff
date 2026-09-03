"use client";

/**
 * Composite hook for getting scenes into the canvas: the initial-data promise
 * the engine mounts with, shared-scene file injection, the confirm-then-load
 * flow the Dashboard triggers, the remote-revision conflict check, and the
 * theme resync after a load. Groups what `ExcalidrawEditor` used to run as
 * separate hooks and effects; the effects themselves are unchanged.
 */

import { useEffect, useState } from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@drawstuff/excalidraw-adapter/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useApplyRemoteScene } from "@/hooks/excalidraw/use-apply-remote-scene";
import { useFetchAndInjectSharedSceneFiles } from "@/hooks/excalidraw/use-fetch-and-inject-shared-scene-files";
import { useLoadSceneWithConfirm } from "@/hooks/excalidraw/use-load-scene-with-confirm";
import type { UseSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";
import { useSceneRemoteRevisionCheck } from "@/hooks/excalidraw/use-scene-remote-revision-check";
import type { useCloudUpload } from "@/hooks/use-cloud-upload";
import type { useSyncTheme } from "@/hooks/use-sync-theme";
import { LOAD_SCENE_EVENT, type LoadSceneRequestDetail } from "@/lib/events";
import { createInitialDataPromise } from "@/lib/excalidraw";
import type { AuthSessionData } from "@/lib/types";
import { api } from "@/trpc/react";

type CloudUpload = ReturnType<typeof useCloudUpload>;

export function useEditorSceneLoading(options: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  session: AuthSessionData;
  browserActiveTheme: ReturnType<typeof useSyncTheme>["browserActiveTheme"];
  hasCurrentCanvasContent: () => boolean;
  sceneChangeConfirm: Pick<
    UseSceneChangeConfirm,
    | "isSceneChangeDialogOpen"
    | "requestSceneChangeDecision"
    | "setSceneChangeDialogLoading"
    | "closeSceneChangeDialog"
  >;
  uploadSceneToCloud: CloudUpload["uploadSceneToCloud"];
  uploadStatus: CloudUpload["status"];
  isCloudUploadDialogOpen: boolean;
  lastConflict: CloudUpload["lastConflict"];
  clearLastConflict: CloudUpload["clearLastConflict"];
}) {
  const {
    excalidrawAPI,
    session,
    browserActiveTheme,
    hasCurrentCanvasContent,
    sceneChangeConfirm,
    uploadSceneToCloud,
    uploadStatus,
    isCloudUploadDialogOpen,
    lastConflict,
    clearLastConflict,
  } = options;
  const {
    reloadSceneSession,
    suppressDirtyTracking,
    resumeDirtyTracking,
    isSessionReady,
    currentWorkspaceId,
  } = useSceneSession();
  const [initialDataPromise, setInitialDataPromise] =
    useState<Promise<ExcalidrawInitialDataState | null> | null>(null);
  const { applyRemoteScene } = useApplyRemoteScene(excalidrawAPI);
  const setLastActiveMutation = api.workspace.setLastActive.useMutation();
  const utils = api.useUtils();

  useEffect(() => {
    // 註冊 handler 後再建立 initialDataPromise，避免 race
    suppressDirtyTracking();
    const nextInitialDataPromise = createInitialDataPromise();
    setInitialDataPromise(nextInitialDataPromise);
    void nextInitialDataPromise.finally(() => {
      try {
        reloadSceneSession();
      } finally {
        // Excalidraw may fire onChange after receiving initialData;
        // resume after a frame so those events don't mark dirty.
        // Placed in finally so suppression never leaks if reload throws.
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    });
  }, [reloadSceneSession, suppressDirtyTracking, resumeDirtyTracking]);

  // 解析分享資訊、取檔並注入 Excalidraw
  useFetchAndInjectSharedSceneFiles(excalidrawAPI);

  // 建立帶確認的載入動作
  const { loadSceneWithConfirm } = useLoadSceneWithConfirm({
    hasCurrentContent: hasCurrentCanvasContent,
    requestSceneChangeDecision: sceneChangeConfirm.requestSceneChangeDecision,
    setSceneChangeLoading: sceneChangeConfirm.setSceneChangeDialogLoading,
    closeSceneChangeConfirm: sceneChangeConfirm.closeSceneChangeDialog,
    uploadSceneToCloud,
    setLastActive: async (workspaceId: string) => {
      await setLastActiveMutation.mutateAsync({ workspaceId });
    },
    invalidate: async () => {
      try {
        await Promise.all([
          utils.workspace.listWithMeta.invalidate(),
          utils.scene.getUserScenesInfinite.invalidate(),
        ]);
      } catch {
        // ignore
      }
    },
    applyRemoteScene,
    getActiveTheme: () => browserActiveTheme,
  });

  const { conflictDialog } = useSceneRemoteRevisionCheck({
    applyRemoteScene,
    uploadSceneToCloud,
    getActiveTheme: () => browserActiveTheme,
    workspaceId: currentWorkspaceId,
    isReady: !!excalidrawAPI && isSessionReady && !!session,
    isUploadInProgress: uploadStatus === "uploading",
    isBlockingDialogOpen:
      sceneChangeConfirm.isSceneChangeDialogOpen || isCloudUploadDialogOpen,
    externalConflict: lastConflict,
    onExternalConflictHandled: clearLastConflict,
  });

  // 處理從 Dashboard 雙擊卡片觸發的載入事件（事件驅動，不用 URL hash）
  useEffect(() => {
    function onLoadSceneEvent(ev: Event): void {
      const e = ev as CustomEvent<LoadSceneRequestDetail>;
      if (!e?.detail?.sceneId) return;
      void loadSceneWithConfirm({
        sceneId: e.detail.sceneId,
        workspaceId: e.detail.workspaceId,
      });
    }

    window.addEventListener(LOAD_SCENE_EVENT, onLoadSceneEvent);
    return () => window.removeEventListener(LOAD_SCENE_EVENT, onLoadSceneEvent);
  }, [loadSceneWithConfirm]);

  const { closeSceneChangeDialog } = sceneChangeConfirm;
  useEffect(() => {
    if (!lastConflict) return;
    closeSceneChangeDialog();
  }, [lastConflict, closeSceneChangeDialog]);

  useEffect(() => {
    // 同步 Excalidraw appState.theme 與目前主題，避免載入/初始狀態殘留舊主題
    if (!excalidrawAPI) return;
    const current = excalidrawAPI.getAppState();
    if (current && current.theme !== browserActiveTheme) {
      excalidrawAPI.updateScene({
        appState: { ...current, theme: browserActiveTheme },
      });
    }
  }, [excalidrawAPI, browserActiveTheme]);

  return { initialDataPromise, conflictDialog };
}
