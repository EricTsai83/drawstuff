"use client";

import type { ApplyRemoteScene } from "@/hooks/excalidraw/use-apply-remote-scene";

import { useCallback } from "react";
import { toast } from "sonner";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useAppI18n } from "@/hooks/use-app-i18n";

export type LoadSceneParams = {
  sceneId: string;
  workspaceId?: string;
};

export type UseLoadSceneWithConfirmParams = {
  hasCurrentContent: () => boolean;
  requestSceneChangeDecision: () => Promise<"save" | "switch" | "cancel">;
  setSceneChangeLoading?: (loading: boolean) => void;
  closeSceneChangeConfirm?: () => void;
  uploadSceneToCloud: (opts?: {
    workspaceId?: string;
    suppressSuccessToast?: boolean;
  }) => Promise<boolean>;
  setLastActive?: (workspaceId: string) => Promise<void>;
  invalidate?: () => Promise<void>;
  applyRemoteScene: ApplyRemoteScene;
  // 擷取目前啟用的主題（避免載入場景時套用舊主題）
  getActiveTheme?: () => "dark" | "light";
};

export function useLoadSceneWithConfirm({
  hasCurrentContent,
  requestSceneChangeDecision,
  setSceneChangeLoading,
  closeSceneChangeConfirm,
  uploadSceneToCloud,
  setLastActive,
  invalidate,
  applyRemoteScene,
  getActiveTheme,
}: UseLoadSceneWithConfirmParams) {
  const { currentSceneId } = useSceneSession();
  const { t } = useAppI18n();
  const loadSceneWithConfirm = useCallback(
    async ({ sceneId, workspaceId }: LoadSceneParams) => {
      try {
        if (sceneId === currentSceneId) {
          toast.info(t("dashboard.sceneAlreadyOpen"));
          return;
        }
        if (hasCurrentContent()) {
          // A failed save consumes the previous decision; re-arm the same
          // dialog before accepting a retry, discard or cancel.
          while (true) {
            const choice = await requestSceneChangeDecision();
            if (choice === "cancel") return;
            if (choice === "save") {
              setSceneChangeLoading?.(true);
              let saveOk = false;
              try {
                // Save the current scene in its own workspace, not the target's.
                saveOk = await uploadSceneToCloud({
                  suppressSuccessToast: true,
                });
              } catch {
                // Keep the canvas intact and let the user choose again.
              } finally {
                setSceneChangeLoading?.(false);
              }
              if (!saveOk) continue;
            }
            closeSceneChangeConfirm?.();
            break;
          }
        }

        const applyResult = await applyRemoteScene({
          sceneId,
          getActiveTheme,
        });
        if (!applyResult.ok && applyResult.reason === "superseded") return;
        if (!applyResult.ok && applyResult.reason === "canvas_changed") {
          toast.info(t("toast.scene.loadCancelledByEdit"));
          return;
        }
        // "incomplete_files" means the canvas was updated (elements visible)
        // but some image assets are missing — not a blocking failure.
        if (!applyResult.ok && applyResult.reason === "scene_data_missing") {
          throw new Error("Failed to load scene data");
        }

        if (workspaceId && setLastActive) {
          try {
            await setLastActive(workspaceId);
            if (invalidate) {
              await invalidate();
            }
          } catch (error) {
            console.error("Failed to update last active workspace", error);
          }
        }

        toast.success(t("toast.scene.loaded"));
      } catch (error) {
        console.error("Failed to load specified scene", error);
        toast.error(t("toast.scene.loadFailed"));
      }
    },
    [
      hasCurrentContent,
      requestSceneChangeDecision,
      setSceneChangeLoading,
      closeSceneChangeConfirm,
      uploadSceneToCloud,
      setLastActive,
      invalidate,
      applyRemoteScene,
      getActiveTheme,
      currentSceneId,
      t,
    ],
  );

  return { loadSceneWithConfirm } as const;
}
