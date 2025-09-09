"use client";

import { useCallback } from "react";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import {
  importSceneDataBySceneId,
  getFileRecordsBySceneId,
} from "@/lib/import-data-from-db";
import { toast } from "sonner";
import { STORAGE_KEYS } from "@/config/app-constants";

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
  const loadSceneWithConfirm = useCallback(
    async ({ sceneId, workspaceId }: LoadSceneParams) => {
      try {
        if (hasCurrentContent()) {
          const choice = await requestSceneChangeDecision();
          if (choice === "cancel") return;
          if (choice === "save") {
            setSceneChangeLoading?.(true);
            try {
              const ok = await uploadSceneToCloud({
                workspaceId,
                suppressSuccessToast: true,
              });
              if (!ok) {
                // 保持對話框開啟，讓使用者可重試或取消
                return;
              }
            } catch {
              // 儲存失敗也繼續嘗試導入
            } finally {
              setSceneChangeLoading?.(false);
            }
            // 儲存成功，關閉對話框
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

        // 並行抓取並注入資產（雲端場景）
        try {
          const decoder = new TextDecoder();
          const records = await getFileRecordsBySceneId(sceneId);
          if (Array.isArray(records) && records.length > 0) {
            const existing = excalidrawAPI?.getFiles?.() ?? {};
            const toAdd: Array<{
              id: string;
              dataURL: string;
              mimeType: string;
              created: number;
              lastRetrieved: number;
            }> = [];
            await Promise.allSettled(
              records.map(async (r) => {
                try {
                  const resp = await fetch(r.url);
                  if (!resp.ok) return;
                  const buf = new Uint8Array(await resp.arrayBuffer());
                  const { metadata, data } = await import("@/lib/encode").then(
                    (m) =>
                      m.decompressData<{
                        id: string;
                        mimeType: string;
                        created: number;
                        lastRetrieved: number;
                      }>(buf, { decryptionKey: "" }),
                  );
                  const id = metadata.id;
                  if (!existing[id]) {
                    toAdd.push({
                      id,
                      dataURL: decoder.decode(data),
                      mimeType: metadata.mimeType,
                      created: metadata.created,
                      lastRetrieved: metadata.lastRetrieved,
                    });
                  }
                } catch {
                  // 忽略單檔失敗
                }
              }),
            );
            if (toAdd.length > 0) {
              excalidrawAPI?.addFiles?.(toAdd as unknown as any);
            }
          }
        } catch {
          // 忽略資產回填失敗，不阻斷導入
        }

        try {
          localStorage.setItem(STORAGE_KEYS.CURRENT_SCENE_ID, sceneId);
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
    ],
  );

  return { loadSceneWithConfirm } as const;
}
