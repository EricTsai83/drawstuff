"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  hasCompleteSceneFileHydration,
  saveToLocalStorage,
} from "@/lib/excalidraw";
import {
  importSceneDataBySceneId,
  importSceneFilesBySceneId,
} from "@/lib/import-data-from-db";
import { useSceneSession } from "@/hooks/scene-session-context";
import type {
  WhiteboardAsset,
  WhiteboardDocumentState,
  WhiteboardEngine,
} from "@/features/whiteboard";

type ApplyRemoteSceneParams = {
  sceneId: string;
  getActiveTheme?: () => "dark" | "light";
  shouldCenter?: boolean;
};

type ApplyRemoteSceneResult =
  | { ok: true; revision?: number }
  | { ok: false; reason: "scene_data_missing" | "incomplete_files" };

/** The canvas was updated — true even when some image assets are still missing. */
export function isApplyResultAcceptable(
  result: ApplyRemoteSceneResult,
): boolean {
  return result.ok || result.reason === "incomplete_files";
}

export function useApplyRemoteScene(engine: WhiteboardEngine | null) {
  const cancelCenteringRef = useRef<(() => void) | null>(null);
  const { suppressDirtyTracking, resumeDirtyTracking, syncCurrentScene } =
    useSceneSession();

  useEffect(
    () => () => {
      cancelCenteringRef.current?.();
      cancelCenteringRef.current = null;
    },
    [engine],
  );

  const applyRemoteScene = useCallback(
    async ({
      sceneId,
      getActiveTheme,
      shouldCenter = true,
    }: ApplyRemoteSceneParams): Promise<ApplyRemoteSceneResult> => {
      if (!engine) {
        return { ok: false, reason: "scene_data_missing" };
      }
      cancelCenteringRef.current?.();
      cancelCenteringRef.current = null;

      // 1. Fetch scene data and files in parallel for faster perceived load
      let imported: Awaited<ReturnType<typeof importSceneDataBySceneId>>;
      let fetchedFiles: Readonly<Record<string, WhiteboardAsset>>;
      try {
        [imported, fetchedFiles] = await Promise.all([
          importSceneDataBySceneId(sceneId),
          importSceneFilesBySceneId(sceneId).catch(
            (): Readonly<Record<string, WhiteboardAsset>> => ({}),
          ),
        ]);
      } catch (error) {
        console.error("Failed to import remote scene data:", error);
        return { ok: false, reason: "scene_data_missing" };
      }

      if (!imported?.elements && !imported?.appState) {
        return { ok: false, reason: "scene_data_missing" };
      }
      const hydratedFiles: Readonly<Record<string, WhiteboardAsset>> = {
        ...(imported.files as
          Readonly<Record<string, WhiteboardAsset>> | undefined),
        ...fetchedFiles,
      };

      // 2. Prepare merged appState
      const baseAppState = engine.getDocument().state;
      const mergedAppState: WhiteboardDocumentState = {
        ...baseAppState,
        ...(imported.appState as WhiteboardDocumentState | undefined),
        theme: getActiveTheme?.() ?? baseAppState.theme ?? "light",
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
        engine.loadDocument({
          elements,
          state: mergedAppState,
          assets: hydratedFiles,
        });

        // 4. Center viewport before file injection so the user sees content ASAP
        const hasViewportFromImported = Boolean(
          imported.appState &&
          (typeof imported.appState.scrollX === "number" ||
            typeof imported.appState.scrollY === "number" ||
            typeof imported.appState.zoom === "object"),
        );

        if (shouldCenter && !hasViewportFromImported) {
          cancelCenteringRef.current = queueCenterToContent(engine);
        }

        // 5. Inject files (already fetched in parallel, so this is instant)
        // 6. Validate file completeness — determines whether we can trust
        //    the local snapshot as a reliable cache for next startup.
        const filesComplete = hasCompleteSceneFileHydration(
          elements,
          hydratedFiles as Parameters<typeof hasCompleteSceneFileHydration>[1],
        );

        if (filesComplete) {
          // Full hydration: persist to localStorage so next cold-start is instant.
          saveToLocalStorage(
            elements,
            mergedAppState as Parameters<typeof saveToLocalStorage>[1],
            hydratedFiles as Parameters<typeof saveToLocalStorage>[2],
          );
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
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    },
    [engine, suppressDirtyTracking, resumeDirtyTracking, syncCurrentScene],
  );

  return { applyRemoteScene } as const;
}

function queueCenterToContent(engine: WhiteboardEngine): () => void {
  let attempts = 0;
  let cancelled = false;
  let timer: number | undefined;
  const tryCenter = () => {
    if (cancelled) return;
    attempts += 1;
    let elements: ReturnType<WhiteboardEngine["getDocument"]>["elements"];
    try {
      elements = engine.getDocument().elements;
    } catch {
      return;
    }
    const hasContent = elements.some((element) => !element.isDeleted);
    if (hasContent) {
      engine.fitToContent({
        viewportZoomFactor: 0.5,
        animate: false,
      });
      return;
    }
    if (attempts < 10) {
      timer = window.setTimeout(tryCenter, 80);
    }
  };

  timer = window.setTimeout(tryCenter, 0);
  return () => {
    cancelled = true;
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  };
}
