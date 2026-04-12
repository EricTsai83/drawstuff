"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

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
  applyRemoteScene: (params: {
    sceneId: string;
    getActiveTheme?: () => "dark" | "light";
  }) => Promise<{ ok: boolean; reason?: string }>;
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
  const { t } = useStandaloneI18n();
  const loadSceneWithConfirm = useCallback(
    async ({ sceneId, workspaceId }: LoadSceneParams) => {
      try {
        if (sceneId === currentSceneId) {
          toast.info(t("dashboard.sceneAlreadyOpen"));
          return;
        }
        if (hasCurrentContent()) {
          const choice = await requestSceneChangeDecision();
          if (choice === "cancel") return;
          if (choice === "save") {
            setSceneChangeLoading?.(true);
            let saveOk = false;
            try {
              saveOk = await uploadSceneToCloud({
                workspaceId,
                suppressSuccessToast: true,
              });
            } catch {
              // 與 !ok 相同：未成功寫入雲端前不可切場景（避免違反「先存再換」）
              saveOk = false;
            } finally {
              setSceneChangeLoading?.(false);
            }
            if (!saveOk) {
              // 保持對話框開啟，讓使用者可重試或改選「不存就換」
              return;
            }
            closeSceneChangeConfirm?.();
          } else if (choice === "switch") {
            // 直接覆蓋，先關閉對話框
            closeSceneChangeConfirm?.();
          }
        }

        const applyResult = await applyRemoteScene({
          sceneId,
          getActiveTheme,
        });
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

        toast.success("Scene loaded");
      } catch (error) {
        console.error("Failed to load specified scene", error);
        toast.error("Failed to load scene");
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
