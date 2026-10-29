"use client";

import { useCallback, useEffect, useRef } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import {
  hasCompleteSceneFileHydration,
  saveToLocalStorage,
} from "@/lib/excalidraw";
import {
  importSceneDataBySceneId,
  importSceneFilesBySceneId,
} from "@/lib/import-data-from-db";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  getLocalScenePersistenceGeneration,
  isLocalScenePersistencePaused,
} from "@/data/local-scene-persistence";
import { clearLocalSceneContent } from "@/data/local-storage";
import { releaseCanvasRoom } from "@/lib/collab/canvas-room-marker";

export type ApplyRemoteSceneParams = {
  sceneId: string;
  getActiveTheme?: () => "dark" | "light";
  shouldCenter?: boolean;
  background?: boolean;
};

export type ApplyRemoteSceneResult =
  | { ok: true; revision?: number }
  | {
      ok: false;
      reason:
        | "scene_data_missing"
        | "incomplete_files"
        | "superseded"
        | "canvas_changed";
    };

/** The canvas was updated — true even when some image assets are still missing. */
export function isApplyResultAcceptable(
  result: ApplyRemoteSceneResult,
): boolean {
  return result.ok || result.reason === "incomplete_files";
}

export type ApplyRemoteScene = (
  params: ApplyRemoteSceneParams,
) => Promise<ApplyRemoteSceneResult>;

export function useApplyRemoteScene(
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) {
  const {
    suppressDirtyTracking,
    resumeDirtyTracking,
    syncCurrentScene,
    getCanvasGeneration,
    getCurrentSceneIdentity,
  } = useSceneSession();
  /** Cancels the centering retries of the latest apply; a newer apply or an
   *  unmount must not let a stale chain scroll the canvas. */
  const cancelPendingCenterRef = useRef<(() => void) | undefined>(undefined);
  const pendingRef = useRef<{
    controller: AbortController;
    background: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      pendingRef.current?.controller.abort();
      pendingRef.current = null;
      cancelPendingCenterRef.current?.();
    },
    [excalidrawAPI],
  );

  const applyRemoteScene = useCallback(
    async ({
      sceneId,
      getActiveTheme,
      shouldCenter = true,
      background = false,
    }: ApplyRemoteSceneParams): Promise<ApplyRemoteSceneResult> => {
      if (!excalidrawAPI || isLocalScenePersistencePaused()) {
        return { ok: false, reason: "scene_data_missing" };
      }

      // Background refreshes must never supersede an explicit user load.
      if (background && pendingRef.current && !pendingRef.current.background)
        return { ok: false, reason: "superseded" };
      pendingRef.current?.controller.abort();
      const request = { controller: new AbortController(), background };
      pendingRef.current = request;
      const canvasGeneration = getCanvasGeneration();
      const persistenceGeneration = getLocalScenePersistenceGeneration();
      const initialContent = captureContent(excalidrawAPI);
      const isSuperseded = () =>
        request.controller.signal.aborted ||
        pendingRef.current !== request ||
        getCanvasGeneration() !== canvasGeneration ||
        getLocalScenePersistenceGeneration() !== persistenceGeneration ||
        isLocalScenePersistencePaused();
      const finish = (
        result: ApplyRemoteSceneResult,
      ): ApplyRemoteSceneResult => {
        if (pendingRef.current === request) pendingRef.current = null;
        return result;
      };

      // 1. Fetch scene data and files in parallel for faster perceived load
      let imported: Awaited<ReturnType<typeof importSceneDataBySceneId>>;
      let fetchedFiles: BinaryFiles;
      try {
        [imported, fetchedFiles] = await Promise.all([
          importSceneDataBySceneId(sceneId, request.controller.signal),
          importSceneFilesBySceneId(sceneId, request.controller.signal).catch(
            (): BinaryFiles => ({}),
          ),
        ]);
      } catch (error) {
        if (isSuperseded()) return finish({ ok: false, reason: "superseded" });
        console.error("Failed to import remote scene data:", error);
        return finish({ ok: false, reason: "scene_data_missing" });
      }

      // No side effects before this check: stale replies cannot touch the
      // canvas, cache, identity, centering or caller notifications.
      if (isSuperseded()) return finish({ ok: false, reason: "superseded" });
      if (
        hasContentChanged(excalidrawAPI, initialContent) ||
        (background && getCurrentSceneIdentity().isDirty)
      )
        return finish({ ok: false, reason: "canvas_changed" });

      if (!imported?.elements && !imported?.appState) {
        return finish({ ok: false, reason: "scene_data_missing" });
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
        // This is a genuine canvas replacement, so any collaboration room's
        // claim on the canvas ends here — before the first write, in the same
        // synchronous block, which is what a live session's `canSyncScene` reads.
        releaseCanvasRoom();
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
            typeof (imported.appState as Partial<AppState>).zoom === "object"),
        );

        cancelPendingCenterRef.current?.();
        cancelPendingCenterRef.current = undefined;
        if (shouldCenter && !hasViewportFromImported) {
          cancelPendingCenterRef.current = queueCenterToContent(excalidrawAPI);
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

        // Full hydration: persist to localStorage so next cold-start is instant.
        const cached =
          filesComplete &&
          saveToLocalStorage(elements, mergedAppState, fetchedFiles);
        if (!cached) {
          // The cache still holds the previous scene (a failed save restores
          // it). Drop it before the identity below switches, or a reload would
          // show the old content as this scene and a save could overwrite it.
          clearLocalSceneContent();
        }
        // Always sync the session (id + revision) regardless of file completeness,
        // so the revision check keeps working.
        syncCurrentScene({
          id: sceneId,
          revision: imported.revision,
          workspaceId: imported.workspaceId,
        });

        if (!filesComplete) {
          return { ok: false, reason: "incomplete_files" };
        }

        return {
          ok: true,
          revision: imported.revision,
        };
      } catch (error) {
        console.error("Failed to apply remote scene to canvas:", error);
        return { ok: false, reason: "scene_data_missing" };
      } finally {
        // Resume after one frame so Excalidraw's synchronous onChange events
        // (triggered by updateScene / addFiles) are still suppressed, but
        // subsequent user edits are tracked normally.
        if (pendingRef.current === request) pendingRef.current = null;
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    },
    [
      excalidrawAPI,
      suppressDirtyTracking,
      resumeDirtyTracking,
      syncCurrentScene,
      getCanvasGeneration,
      getCurrentSceneIdentity,
    ],
  );

  return { applyRemoteScene } as const;
}

/** Retries until the scene has content, then centers once. Returns a cancel. */
function queueCenterToContent(
  excalidrawAPI: ExcalidrawImperativeAPI,
): () => void {
  let attempts = 0;
  let timerId: number | undefined;
  const tryCenter = () => {
    timerId = undefined;
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
      timerId = window.setTimeout(tryCenter, 80);
    }
  };

  timerId = window.setTimeout(tryCenter, 0);
  return () => {
    if (timerId !== undefined) window.clearTimeout(timerId);
    timerId = undefined;
  };
}

/** Compare scene content only at the two async boundaries, never on each frame.
 * Selection, panning and opening sidebars do not invalidate a pending load. */
function captureContent(api: ExcalidrawImperativeAPI) {
  const state = api.getAppState();
  return {
    elements: api.getSceneElementsIncludingDeleted().map((element) => ({
      id: element.id,
      version: element.version,
      versionNonce: element.versionNonce,
      isDeleted: element.isDeleted,
    })),
    name: state.name,
    viewBackgroundColor: state.viewBackgroundColor,
    gridSize: state.gridSize,
  };
}

function hasContentChanged(
  api: ExcalidrawImperativeAPI,
  snapshot: ReturnType<typeof captureContent>,
): boolean {
  const elements = api.getSceneElementsIncludingDeleted();
  const state = api.getAppState();
  return (
    state.name !== snapshot.name ||
    state.viewBackgroundColor !== snapshot.viewBackgroundColor ||
    state.gridSize !== snapshot.gridSize ||
    elements.length !== snapshot.elements.length ||
    elements.some((element, index) => {
      const previous = snapshot.elements[index]!;
      return (
        element.id !== previous.id ||
        element.version !== previous.version ||
        element.versionNonce !== previous.versionNonce ||
        element.isDeleted !== previous.isDeleted
      );
    })
  );
}
