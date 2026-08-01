"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { authClient } from "@/lib/auth/client";
import { api } from "@/trpc/react";

type CreateNewSceneParams = {
  name: string;
  description?: string;
  workspaceId?: string;
  newWorkspaceName?: string;
  keepCurrentContent: boolean;
};

type UseCreateNewSceneOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  handleSetSceneName: (name: string) => void;
  clearCurrentScene: () => void;
  uploadSceneToCloud: (input: {
    name: string;
    description?: string;
    workspaceId?: string;
    mode: "create";
    suppressSuccessToast: boolean;
  }) => Promise<boolean>;
  setLastActiveWorkspace: (workspaceId: string) => Promise<unknown>;
};

const DEFAULT_ZOOM_VALUE = 1 as AppState["zoom"]["value"];

function createResetZoomState(
  currentZoom: AppState["zoom"] | undefined,
): AppState["zoom"] {
  if (
    currentZoom &&
    typeof currentZoom.value === "number" &&
    Number.isFinite(currentZoom.value)
  ) {
    return { ...currentZoom, value: DEFAULT_ZOOM_VALUE };
  }
  return { value: DEFAULT_ZOOM_VALUE };
}

export function useCreateNewScene({
  excalidrawAPI,
  handleSetSceneName,
  clearCurrentScene,
  uploadSceneToCloud,
  setLastActiveWorkspace,
}: UseCreateNewSceneOptions) {
  const { t } = useAppI18n();
  const { data: session } = authClient.useSession();
  const utils = api.useUtils();
  const createWorkspaceMutation = api.workspace.create.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });

  return useCallback(
    async ({
      name,
      description,
      workspaceId,
      newWorkspaceName,
      keepCurrentContent,
    }: CreateNewSceneParams) => {
      try {
        // 更新場景名稱（不論保留或重置）
        handleSetSceneName(name);

        // 先決定要使用的 workspaceId（若有 newWorkspaceName，避免重複名稱）
        let workspaceIdToUse: string | undefined = workspaceId;
        if (!workspaceIdToUse) {
          const trimmedName = (newWorkspaceName ?? "").trim();
          if (trimmedName.length > 0) {
            const existing =
              utils.workspace.listWithMeta.getData()?.workspaces ?? [];
            const matched = existing.find(
              (w) => w.name.trim().toLowerCase() === trimmedName.toLowerCase(),
            );
            if (matched) {
              workspaceIdToUse = matched.id;
            } else {
              const created = await createWorkspaceMutation.mutateAsync({
                name: trimmedName,
              });
              workspaceIdToUse = created.id;
            }
          }
        }

        // 更新最後啟用 workspace（若選擇或新建）
        if (workspaceIdToUse) {
          await setLastActiveWorkspace(workspaceIdToUse);
        }

        if (keepCurrentContent) {
          if (!session) {
            // 本地模式：直接清除場景 session（無雲端操作）
            clearCurrentScene();
            toast.info(t("toasts.newScene.localOnly"));
            return;
          }
          // 先清除再上傳；若上傳失敗，場景仍在畫布上（只是失去 id）
          clearCurrentScene();
          // 直接以目前內容建立新雲端場景，並自動關聯縮圖與資產
          const ok = await uploadSceneToCloud({
            name,
            description,
            workspaceId: workspaceIdToUse,
            mode: "create",
            suppressSuccessToast: true,
          });
          if (!ok) return;
          toast.success(t("toasts.newSceneCreated"));
        } else {
          // 新建場景的語義：清除 currentSceneId，避免覆寫既有場景
          clearCurrentScene();
          // 重置畫布為空
          const currentAppState = excalidrawAPI?.getAppState() as
            AppState | undefined;
          if (currentAppState) {
            const resetZoom = createResetZoomState(currentAppState.zoom);
            excalidrawAPI?.updateScene({
              elements: [],
              appState: {
                ...currentAppState,
                zoom: resetZoom,
                name,
              },
            });
          }
          // 需求：Create 時立即做第一次儲存
          if (!session) {
            toast.info(t("toasts.newEmptyScene.localOnly"));
            return;
          }
          const ok = await uploadSceneToCloud({
            name,
            description,
            workspaceId: workspaceIdToUse,
            mode: "create",
            suppressSuccessToast: true,
          });
          if (!ok) return;
          toast.success(t("toasts.newSceneCreated"));
        }
      } catch (err) {
        console.error(err);
        toast.error((err as Error)?.message ?? t("errors.failedToCreateScene"));
      }
    },
    [
      clearCurrentScene,
      excalidrawAPI,
      handleSetSceneName,
      setLastActiveWorkspace,
      utils,
      createWorkspaceMutation,
      uploadSceneToCloud,
      session,
      t,
    ],
  );
}
