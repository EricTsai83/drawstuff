"use client";

import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import { useBeforeUnload } from "@/hooks/whiteboard/use-before-unload";
import { createInitialWhiteboardDocument } from "@/lib/whiteboard";
import { SceneRenameDialog } from "@/components/whiteboard/scene-rename-dialog";
import { authClient } from "@/lib/auth/client";
import { useSceneExport } from "@/hooks/use-scene-export";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { useConfirmBeforeUnload } from "@/hooks/use-confirm-before-unload";
import { SceneCloudUploadDialog } from "@/components/whiteboard/scene-cloud-upload-dialog";
import { OverwriteConfirmDialog } from "@/components/whiteboard/overwrite-confirm-dialog";
import { useFetchAndInjectSharedSceneFiles } from "@/hooks/whiteboard/use-fetch-and-inject-shared-scene-files";
import { useScenePersistence } from "@/hooks/whiteboard/use-scene-persistence";
import { SceneShareDialog } from "@/components/scene-share-dialog";
import WorkspaceSettingsDialog from "@/components/whiteboard/workspace-settings-dialog";
import { useDashboardShortcut } from "@/hooks/use-dashboard-shortcut";
import { LOAD_SCENE_EVENT, type LoadSceneRequestDetail } from "@/lib/events";
import { SceneChangeConfirmDialog } from "./scene-change-confirm-dialog";
import { api } from "@/trpc/react";
import { useSceneChangeConfirm } from "@/hooks/whiteboard/use-scene-change-confirm";
import { useLoadSceneWithConfirm } from "@/hooks/whiteboard/use-load-scene-with-confirm";
import { useSceneImportFileGuard } from "@/hooks/whiteboard/use-scene-import-file-guard";
import { useApplyRemoteScene } from "@/hooks/whiteboard/use-apply-remote-scene";
import { useSceneRemoteRevisionCheck } from "@/hooks/whiteboard/use-scene-remote-revision-check";
import { SceneRemoteConflictDialog } from "@/components/whiteboard/scene-remote-conflict-dialog";
import { useSceneSession } from "@/hooks/scene-session-context";
import type { WhiteboardEngine } from "@drawstuff/whiteboard";
import {
  recordWhiteboardDiagnostic,
  WHITEBOARD_DOCUMENT_VERSION,
} from "@drawstuff/whiteboard";
import { WhiteboardShell } from "@/features/whiteboard/ui";
import { WhiteboardProductMenu } from "./whiteboard-product-menu";
import { OwnedWhiteboardCanvas } from "@drawstuff/whiteboard";
import { consumeWhiteboardV3ResetNotice } from "@/data/local-storage";

export default function WhiteboardEditor() {
  useSceneImportFileGuard();
  const [engine, setEngine] = useState<WhiteboardEngine | null>(null);
  const { browserActiveTheme } = useSyncTheme();
  useBeforeUnload(engine);
  const {
    reloadSceneSession,
    suppressDirtyTracking,
    resumeDirtyTracking,
    isSessionReady,
    updateLastSyncedRevision,
    currentWorkspaceId,
  } = useSceneSession();
  const [initialDataPromise, setInitialDataPromise] = useState<Promise<
    Awaited<ReturnType<typeof createInitialWhiteboardDocument>>
  > | null>(null);
  const { data: session } = authClient.useSession();
  // 只在編輯器中、且使用者已登入時啟用 Dashboard 快捷鍵
  useDashboardShortcut(!!session);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] = useState(false);
  const {
    exportScene,
    exportStatus,
    exportErrorMessage,
    latestShareableLink,
    resetExportStatus,
  } = useSceneExport();
  const { sceneName, handleSetSceneName } = useScenePersistence(engine);
  const {
    status: uploadStatus,
    uploadSceneToCloud,
    resetStatus,
    currentSceneId,
    clearCurrentScene,
    lastConflict,
    clearLastConflict,
  } = useCloudUpload(() => {
    setIsCloudUploadDialogOpen(true);
  }, engine);
  const { applyRemoteScene } = useApplyRemoteScene(engine);
  const [isCloudUploadDialogOpen, setIsCloudUploadDialogOpen] = useState(false);
  const setLastActiveMutation = api.workspace.setLastActive.useMutation();
  const utils = api.useUtils();
  const renameSceneMutation = api.scene.renameScene.useMutation();
  // 取得換場景確認 Dialog 控制方法（語意清楚的鍵名）
  const {
    isSceneChangeDialogOpen,
    isSceneChangeDialogLoading,
    handleSceneChangeDialogOpenChange,
    requestSceneChangeDecision,
    resolveSceneChangeDecision,
    setSceneChangeDialogLoading,
    closeSceneChangeDialog,
  } = useSceneChangeConfirm();

  // 當雲端上傳進行中時，阻止關閉視窗/重整，直到使用者確認
  useConfirmBeforeUnload(uploadStatus === "uploading");

  useEffect(() => {
    suppressDirtyTracking();
    const nextInitialDataPromise = createInitialWhiteboardDocument({
      onFailure: (errorCode) => {
        if (errorCode === "LEGACY_SHARE_EXPIRED") {
          toast.error("此分享連結使用舊版格式，已失效");
        }
        recordWhiteboardDiagnostic({
          operation: "load",
          outcome: "failure",
          documentVersion: null,
          errorCode,
        });
      },
    }).then((document) => {
      if (consumeWhiteboardV3ResetNotice()) {
        toast.info("本地草稿已因畫布升級重置");
      }
      recordWhiteboardDiagnostic({
        operation: "load",
        outcome: "success",
        documentVersion: document ? WHITEBOARD_DOCUMENT_VERSION : null,
      });
      return document;
    });
    setInitialDataPromise(nextInitialDataPromise);
    void nextInitialDataPromise.finally(() => {
      try {
        reloadSceneSession();
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    });
  }, [reloadSceneSession, suppressDirtyTracking, resumeDirtyTracking]);

  // 解析分享資訊、取檔並注入白板引擎
  useFetchAndInjectSharedSceneFiles(engine);

  // 建立帶確認的載入動作
  const { loadSceneWithConfirm } = useLoadSceneWithConfirm({
    hasCurrentContent: () => {
      const els = engine?.getDocument().elements ?? [];
      return els.some((element) => !element.isDeleted);
    },
    requestSceneChangeDecision,
    setSceneChangeLoading: setSceneChangeDialogLoading,
    closeSceneChangeConfirm: closeSceneChangeDialog,
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
    isReady: !!engine && isSessionReady && !!session,
    isUploadInProgress: uploadStatus === "uploading",
    isBlockingDialogOpen:
      isSceneChangeDialogOpen ||
      isCloudUploadDialogOpen ||
      isRenameDialogOpen ||
      isWorkspaceDialogOpen,
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

  useEffect(() => {
    if (!lastConflict) return;
    closeSceneChangeDialog();
  }, [lastConflict, closeSceneChangeDialog]);

  const handleCloudUpload = useCallback(async (): Promise<void> => {
    // 若尚未儲存過，先開啟命名/標籤/描述 Dialog
    if (!currentSceneId) {
      setIsCloudUploadDialogOpen(true);
      return;
    }
    await uploadSceneToCloud({ workspaceId: currentWorkspaceId });
  }, [uploadSceneToCloud, currentSceneId, currentWorkspaceId]);

  const handleNewScene = useCallback(async (): Promise<void> => {
    if (!engine) return;

    const hasCurrentContent = engine
      .getDocument()
      .elements.some((element) => !element.isDeleted);
    if (hasCurrentContent) {
      const choice = await requestSceneChangeDecision();
      if (choice === "cancel") return;
      if (choice === "save") {
        if (!currentSceneId) {
          closeSceneChangeDialog();
          setIsCloudUploadDialogOpen(true);
          toast.info("Save the current scene before starting a new one.");
          return;
        }
        setSceneChangeDialogLoading(true);
        let saved = false;
        try {
          saved = await uploadSceneToCloud({
            suppressSuccessToast: true,
          });
        } finally {
          setSceneChangeDialogLoading(false);
        }
        if (!saved) return;
      }
      closeSceneChangeDialog();
    }

    const currentDocument = engine.getDocument();
    clearCurrentScene();
    engine.loadDocument({
      elements: [],
      state: {
        ...currentDocument.state,
        name: "Untitled",
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
        openDialog: null,
        openMenu: null,
      },
      assets: {},
    });
  }, [
    clearCurrentScene,
    closeSceneChangeDialog,
    currentSceneId,
    engine,
    requestSceneChangeDecision,
    setSceneChangeDialogLoading,
    uploadSceneToCloud,
  ]);

  useEffect(() => {
    if (!session) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.isComposing || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s" && event.code !== "KeyS") return;

      // 攔截瀏覽器原生儲存快捷鍵，改走專案的雲端儲存流程。
      event.preventDefault();
      event.stopPropagation();
      void handleCloudUpload();
    }

    // 用 capture phase 盡量比瀏覽器/元件內部快捷鍵更早接手 Cmd/Ctrl+S。
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [session, handleCloudUpload]);

  useEffect(() => {
    if (uploadStatus === "success") {
      const timer = setTimeout(() => {
        resetStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (uploadStatus === "error") {
      toast.error("Failed to upload to cloud. Please try again.");
      const timer = setTimeout(() => {
        resetStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    return;
  }, [uploadStatus, resetStatus]);

  useEffect(() => {
    // 同步白板 state.theme 與目前主題，避免載入後殘留舊主題。
    if (!engine) return;
    if (engine.getEditorState().theme !== browserActiveTheme) {
      engine.updateEditorState({ theme: browserActiveTheme });
    }
  }, [engine, browserActiveTheme]);

  useEffect(() => {
    if (exportStatus === "success") {
      const timer = setTimeout(() => {
        resetExportStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (exportStatus === "error") {
      const message =
        typeof exportErrorMessage === "string"
          ? exportErrorMessage
          : "Failed to export scene. Please try again.";
      toast.error(message);
      const timer = setTimeout(() => {
        resetExportStatus();
      }, 1500);
      return () => clearTimeout(timer);
    }
    return;
  }, [exportStatus, exportErrorMessage, resetExportStatus]);

  const handleShareLinkClick = useCallback(async (): Promise<void> => {
    if (!engine) return;
    const document = engine.getDocument();
    const link = await exportScene(
      document.elements,
      document.state,
      document.assets,
    );
    if (link) setIsShareDialogOpen(true);
  }, [engine, exportScene]);

  const sceneDialogs = (
    <>
      <SceneRenameDialog
        engine={engine}
        open={isRenameDialogOpen}
        onOpenChange={setIsRenameDialogOpen}
        onConfirmName={(newName) => {
          handleSetSceneName(newName);
          if (currentSceneId) {
            renameSceneMutation.mutate(
              { id: currentSceneId, name: newName },
              {
                onSuccess: (data) => {
                  void utils.scene.getUserScenesInfinite.invalidate();
                  if (data.revision != null) {
                    updateLastSyncedRevision(data.revision);
                  }
                },
                onError: () =>
                  toast.error("Failed to update scene name. Please try again."),
              },
            );
          }
        }}
      />
      <SceneChangeConfirmDialog
        open={isSceneChangeDialogOpen}
        onOpenChange={handleSceneChangeDialogOpenChange}
        onChoose={resolveSceneChangeDecision}
        isLoading={Boolean(isSceneChangeDialogLoading)}
      />
      <OverwriteConfirmDialog
        engine={engine}
        clearCurrentSceneId={clearCurrentScene}
        onSceneNotFoundError={() => {
          setIsCloudUploadDialogOpen(true);
        }}
      />
      <SceneRemoteConflictDialog {...conflictDialog} />
      <SceneCloudUploadDialog
        open={isCloudUploadDialogOpen}
        onOpenChange={setIsCloudUploadDialogOpen}
        engine={engine}
        onConfirm={({
          name,
          description,
          categories,
          workspaceId,
        }: {
          name: string;
          description: string;
          categories: string[];
          workspaceId?: string;
        }) => {
          // 先把名稱寫回白板 state，再啟動上傳。
          handleSetSceneName(name);
          void uploadSceneToCloud({
            name,
            description,
            categories,
            workspaceId,
          });
        }}
      />
    </>
  );

  const canvas = !initialDataPromise ? null : (
    <OwnedWhiteboardCanvas
      ariaLabel="Whiteboard editor"
      document={initialDataPromise}
      onEngineReady={setEngine}
    />
  );

  return (
    <div className="h-dvh w-full">
      <WhiteboardShell
        engine={engine}
        isSaving={uploadStatus === "uploading"}
        isSharing={exportStatus === "exporting"}
        onRename={() => setIsRenameDialogOpen(true)}
        onImported={(name) => {
          clearCurrentScene();
          if (name) handleSetSceneName(name);
        }}
        onSave={() => void handleCloudUpload()}
        onShare={() => void handleShareLinkClick()}
        onWorkspace={session ? () => setIsWorkspaceDialogOpen(true) : undefined}
        productMenuContent={
          <WhiteboardProductMenu onNewScene={handleNewScene} />
        }
        sceneName={sceneName}
      >
        {canvas}
      </WhiteboardShell>
      {sceneDialogs}
      <WorkspaceSettingsDialog
        open={isWorkspaceDialogOpen}
        onOpenChange={setIsWorkspaceDialogOpen}
      />
      {latestShareableLink && (
        <SceneShareDialog
          open={isShareDialogOpen}
          onOpenChange={setIsShareDialogOpen}
          sceneUrl={latestShareableLink}
        />
      )}
    </div>
  );
}
