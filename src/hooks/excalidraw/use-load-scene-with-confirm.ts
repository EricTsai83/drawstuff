"use client";

import { useCallback } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  importSceneDataBySceneId,
  importSceneFilesBySceneId,
} from "@/lib/import-data-from-db";
import { toast } from "sonner";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import {
  hasCompleteSceneFileHydration,
  saveToLocalStorage,
} from "@/lib/excalidraw";

export type LoadSceneParams = {
  sceneId: string;
  workspaceId?: string;
};

export type UseLoadSceneWithConfirmParams = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
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
  // 擷取目前啟用的主題（避免載入場景時套用舊主題）
  getActiveTheme?: () => "dark" | "light";
};

export function useLoadSceneWithConfirm({
  excalidrawAPI,
  hasCurrentContent,
  requestSceneChangeDecision,
  setSceneChangeLoading,
  closeSceneChangeConfirm,
  uploadSceneToCloud,
  setLastActive,
  invalidate,
  getActiveTheme,
}: UseLoadSceneWithConfirmParams) {
  const { currentSceneId, saveCurrentSceneId } = useSceneSession();
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

        const imported = await importSceneDataBySceneId(sceneId);
        if (!imported?.elements && !imported?.appState) {
          throw new Error("Failed to load scene data");
        }

        const baseAppState = excalidrawAPI?.getAppState() as
          | AppState
          | undefined;
        const mergedAppState: AppState = {
          ...(baseAppState ?? ({} as AppState)),
          ...(imported.appState ?? {}),
          // 強制使用目前的主題，而不是導入資料內保存的主題
          theme: getActiveTheme?.() ?? baseAppState?.theme ?? "light",
        };

        excalidrawAPI?.updateScene({
          elements: imported.elements ?? [],
          appState: mergedAppState,
        });

        // 若匯入資料包含 viewport（scrollX/scrollY/zoom），則尊重它並略過自動置中
        const hasViewportFromImported = Boolean(
          imported.appState &&
            (typeof imported.appState.scrollX === "number" ||
              typeof imported.appState.scrollY === "number" ||
              typeof (imported.appState as Partial<AppState>).zoom ===
                "object"),
        );

        if (!hasViewportFromImported) {
          // 更新場景後嘗試置中到內容（避免載入後視圖停在舊位置）
          try {
            let attempts = 0;
            const tryCenter = () => {
              attempts += 1;
              const els =
                (excalidrawAPI?.getSceneElements() as readonly ExcalidrawElement[]) ??
                [];
              const hasContent = Array.isArray(els)
                ? els.some((el: ExcalidrawElement) => !el.isDeleted)
                : false;
              if (hasContent) {
                excalidrawAPI?.scrollToContent(undefined, {
                  fitToViewport: true,
                  viewportZoomFactor: 0.5,
                  animate: false,
                });
                return;
              }
              if (attempts < 10) {
                window.setTimeout(tryCenter, 80);
              }
            };
            // 延後到下一個 tick，等 Excalidraw 套用新場景再置中
            window.setTimeout(tryCenter, 0);
          } catch {
            // 忽略置中失敗，不影響載入流程
          }
        }

        let importedFiles: BinaryFiles = {};

        // 並行抓取並注入資產（雲端場景）
        try {
          importedFiles = await importSceneFilesBySceneId(sceneId);
          const filesToInject = Object.values(importedFiles);
          if (filesToInject.length > 0) {
            const existing = excalidrawAPI?.getFiles?.() ?? {};
            excalidrawAPI?.addFiles?.(
              filesToInject.filter((file) => !existing[file.id]),
            );
          }
        } catch {
          // 忽略資產回填失敗，不阻斷導入
        }

        try {
          saveCurrentSceneId(String(sceneId), imported.updatedAt);
          if (
            hasCompleteSceneFileHydration(imported.elements ?? [], importedFiles)
          ) {
            // 只有在檔案水合完整時才寫入本地快照，避免下次啟動跳過重試
            saveToLocalStorage(
              imported.elements ?? [],
              mergedAppState,
              importedFiles,
            );
          }
        } catch {}

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
      excalidrawAPI,
      hasCurrentContent,
      requestSceneChangeDecision,
      setSceneChangeLoading,
      closeSceneChangeConfirm,
      uploadSceneToCloud,
      setLastActive,
      invalidate,
      getActiveTheme,
      currentSceneId,
      saveCurrentSceneId,
      t,
    ],
  );

  return { loadSceneWithConfirm } as const;
}
