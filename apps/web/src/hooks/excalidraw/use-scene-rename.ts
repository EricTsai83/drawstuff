"use client";

import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { loadCurrentSceneIdFromStorage } from "@/data/local-storage";
import { useSceneSession } from "@/hooks/scene-session-context";
import { api } from "@/trpc/react";

/**
 * Renames the current cloud scene, retrying once when the id is not persisted
 * yet (freshly created scenes) or when the server has not caught up.
 */
export function useSceneRename(currentSceneId: string | null | undefined) {
  const utils = api.useUtils();
  const renameSceneMutation = api.scene.renameScene.useMutation();
  const pendingRenameRef = useRef<string | undefined>(undefined);
  const { updateLastSyncedRevision } = useSceneSession();

  const renameScene = useCallback(
    (nextName: string) => {
      const effectiveId = loadCurrentSceneIdFromStorage();
      if (!effectiveId) {
        pendingRenameRef.current = nextName;
        return;
      }
      renameSceneMutation.mutate(
        { id: effectiveId, name: nextName },
        {
          onSuccess: (data) => {
            void utils.scene.getUserScenesInfinite.invalidate();
            if (data.revision != null) {
              updateLastSyncedRevision(data.revision);
            }
          },
          onError: (err) => {
            const code = (err as unknown as { data?: { code?: string } })?.data
              ?.code;
            const msg = (err as unknown as { message?: string })?.message ?? "";
            const isNotFound =
              code === "NOT_FOUND" || msg.includes("Scene not found");
            if (isNotFound) {
              void utils.scene.getUserScenesInfinite.invalidate();
              window.setTimeout(() => {
                const retryId = loadCurrentSceneIdFromStorage();
                if (!retryId) return;
                renameSceneMutation.mutate(
                  { id: retryId, name: nextName },
                  {
                    onSuccess: (data) => {
                      void utils.scene.getUserScenesInfinite.invalidate();
                      if (data.revision != null) {
                        updateLastSyncedRevision(data.revision);
                      }
                    },
                  },
                );
              }, 300);
              return;
            }
            toast.error("Failed to update scene name. Please try again.");
          },
        },
      );
    },
    [renameSceneMutation, utils, updateLastSyncedRevision],
  );

  // 若剛拿到新 id，且有待辦改名，補送 rename
  if (currentSceneId && pendingRenameRef.current) {
    const name = pendingRenameRef.current;
    pendingRenameRef.current = undefined;
    renameScene(name);
  }

  return renameScene;
}
