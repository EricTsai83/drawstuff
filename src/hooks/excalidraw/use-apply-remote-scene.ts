"use client";

import { useCallback } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  hasCompleteSceneFileHydration,
  saveToLocalStorage,
} from "@/lib/excalidraw";
import {
  importSceneDataBySceneId,
  importSceneFilesBySceneId,
} from "@/lib/import-data-from-db";
import { useSceneSession } from "@/hooks/scene-session-context";

type ApplyRemoteSceneParams = {
  sceneId: string;
  getActiveTheme?: () => "dark" | "light";
  shouldCenter?: boolean;
};

type ApplyRemoteSceneResult =
  | { ok: true; revision?: number }
  | { ok: false; reason: "scene_data_missing" | "incomplete_files" };

/** The canvas was updated — true even when some image assets are still missing. */
export function isApplyResultAcceptable(result: ApplyRemoteSceneResult): boolean {
  return result.ok || result.reason === "incomplete_files";
}

export function useApplyRemoteScene(
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) {
  const { suppressDirtyTracking, resumeDirtyTracking, syncCurrentScene } =
    useSceneSession();

  const applyRemoteScene = useCallback(
    async ({
      sceneId,
      getActiveTheme,
      shouldCenter = true,
    }: ApplyRemoteSceneParams): Promise<ApplyRemoteSceneResult> => {
      if (!excalidrawAPI) {
        return { ok: false, reason: "scene_data_missing" };
      }

      // 1. Fetch scene data and files in parallel for faster perceived load
      let imported: Awaited<ReturnType<typeof importSceneDataBySceneId>>;
      let fetchedFiles: BinaryFiles;
      try {
        [imported, fetchedFiles] = await Promise.all([
          importSceneDataBySceneId(sceneId),
          importSceneFilesBySceneId(sceneId).catch(
            (): BinaryFiles => ({}),
          ),
        ]);
      } catch (error) {
        console.error("Failed to import remote scene data:", error);
        return { ok: false, reason: "scene_data_missing" };
      }

      if (!imported?.elements && !imported?.appState) {
        return { ok: false, reason: "scene_data_missing" };
      }

      // 2. Prepare merged appState
      const baseAppState = excalidrawAPI.getAppState() as AppState | undefined;
      const mergedAppState: AppState = {
        ...(baseAppState ?? ({} as AppState)),
        ...(imported.appState ?? {}),
        theme: getActiveTheme?.() ?? baseAppState?.theme ?? "light",
      };

      const elements = imported.elements ?? [];

      // --- Begin scene mutation (suppress dirty tracking) ---
      // All canvas writes happen inside this try block; the finally block
      // guarantees tracking is resumed even if an unexpected error occurs.
      suppressDirtyTracking();
      try {
        // 3. Update canvas — elements are shown immediately.
        //    If the scene has images, Excalidraw renders placeholder boxes for
        //    any fileIds not yet in its file store; we inject files right after.
        excalidrawAPI.updateScene({
          elements,
          appState: mergedAppState,
        });

        // 4. Center viewport before file injection so the user sees content ASAP
        const hasViewportFromImported = Boolean(
          imported.appState &&
            (typeof imported.appState.scrollX === "number" ||
              typeof imported.appState.scrollY === "number" ||
              typeof (imported.appState as Partial<AppState>).zoom ===
                "object"),
        );

        if (shouldCenter && !hasViewportFromImported) {
          queueCenterToContent(excalidrawAPI);
        }

        // 5. Inject files (already fetched in parallel, so this is instant)
        const filesToInject = Object.values(fetchedFiles);
        if (filesToInject.length > 0) {
          const existingFiles = excalidrawAPI.getFiles?.() ?? {};
          excalidrawAPI.addFiles?.(
            filesToInject.filter((file) => !existingFiles[file.id]),
          );
        }

        // 6. Validate file completeness — determines whether we can trust
        //    the local snapshot as a reliable cache for next startup.
        const filesComplete = hasCompleteSceneFileHydration(
          elements,
          fetchedFiles,
        );

        if (filesComplete) {
          // Full hydration: persist to localStorage so next cold-start is instant.
          saveToLocalStorage(elements, mergedAppState, fetchedFiles);
        }
        // Always sync the session (id + revision) regardless of file completeness,
        // so the revision check keeps working.
        syncCurrentScene({
          id: sceneId,
          revision: imported.revision,
        });

        if (!filesComplete) {
          return { ok: false, reason: "incomplete_files" };
        }

        return {
          ok: true,
          revision: imported.revision,
        };
      } finally {
        // Resume after one frame so Excalidraw's synchronous onChange events
        // (triggered by updateScene / addFiles) are still suppressed, but
        // subsequent user edits are tracked normally.
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    },
    [excalidrawAPI, suppressDirtyTracking, resumeDirtyTracking, syncCurrentScene],
  );

  return { applyRemoteScene } as const;
}

function queueCenterToContent(excalidrawAPI: ExcalidrawImperativeAPI) {
  let attempts = 0;
  const tryCenter = () => {
    attempts += 1;
    const elements =
      (excalidrawAPI.getSceneElements() as readonly ExcalidrawElement[]) ?? [];
    const hasContent = elements.some((element) => !element.isDeleted);
    if (hasContent) {
      excalidrawAPI.scrollToContent(undefined, {
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

  window.setTimeout(tryCenter, 0);
}
