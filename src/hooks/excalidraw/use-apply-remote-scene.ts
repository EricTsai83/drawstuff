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

export function useApplyRemoteScene(
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) {
  const { suppressDirtyTracking, syncCurrentScene } = useSceneSession();

  const applyRemoteScene = useCallback(
    async ({
      sceneId,
      getActiveTheme,
      shouldCenter = true,
    }: ApplyRemoteSceneParams): Promise<ApplyRemoteSceneResult> => {
      if (!excalidrawAPI) {
        return { ok: false, reason: "scene_data_missing" };
      }

      const imported = await importSceneDataBySceneId(sceneId);
      if (!imported?.elements && !imported?.appState) {
        return { ok: false, reason: "scene_data_missing" };
      }

      const baseAppState = excalidrawAPI.getAppState() as AppState | undefined;
      const mergedAppState: AppState = {
        ...(baseAppState ?? ({} as AppState)),
        ...(imported.appState ?? {}),
        theme: getActiveTheme?.() ?? baseAppState?.theme ?? "light",
      };

      suppressDirtyTracking();
      excalidrawAPI.updateScene({
        elements: imported.elements ?? [],
        appState: mergedAppState,
      });

      const hasViewportFromImported = Boolean(
        imported.appState &&
          (typeof imported.appState.scrollX === "number" ||
            typeof imported.appState.scrollY === "number" ||
            typeof (imported.appState as Partial<AppState>).zoom === "object"),
      );

      if (shouldCenter && !hasViewportFromImported) {
        queueCenterToContent(excalidrawAPI);
      }

      let importedFiles: BinaryFiles = {};
      try {
        importedFiles = await importSceneFilesBySceneId(sceneId);
        const filesToInject = Object.values(importedFiles);
        if (filesToInject.length > 0) {
          suppressDirtyTracking();
          const existingFiles = excalidrawAPI.getFiles?.() ?? {};
          excalidrawAPI.addFiles?.(
            filesToInject.filter((file) => !existingFiles[file.id]),
          );
        }
      } catch {
        importedFiles = {};
      }

      if (!hasCompleteSceneFileHydration(imported.elements ?? [], importedFiles)) {
        return { ok: false, reason: "incomplete_files" };
      }

      saveToLocalStorage(imported.elements ?? [], mergedAppState, importedFiles);
      syncCurrentScene({
        id: sceneId,
        revision: imported.revision,
      });

      return {
        ok: true,
        revision: imported.revision,
      };
    },
    [excalidrawAPI, suppressDirtyTracking, syncCurrentScene],
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
