"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import { useSceneSession } from "@/hooks/scene-session-context";
import type { CollabPocHandle } from "@/lib/collab/poc";

export type UseCollaborationPocResult = {
  isCollaborating: boolean;
  onPointerUpdate: (payload: ExcalidrawPointerUpdatePayload) => void;
  onSceneChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ) => void;
};

export function useCollaborationPoc(
  excalidrawAPI: ExcalidrawImperativeAPI | null,
): UseCollaborationPocResult {
  const { suppressDirtyTracking, resumeDirtyTracking } = useSceneSession();
  const handleRef = useRef<CollabPocHandle | null>(null);
  const [isCollaborating, setIsCollaborating] = useState(false);

  // Remote input must not mark the scene dirty: suppress tracking for the
  // synchronous onChange the write triggers and resume one frame later
  // (same pattern as use-apply-remote-scene.ts).
  const wrapRemoteApply = useCallback(
    (apply: () => void) => {
      suppressDirtyTracking();
      try {
        apply();
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    },
    [suppressDirtyTracking, resumeDirtyTracking],
  );

  useEffect(() => {
    if (!excalidrawAPI) return;

    let cancelled = false;
    let handle: CollabPocHandle | undefined;

    /**
     * Plan 11 local two-client collaboration POC gate. Both env reads are
     * inlined in this one condition so the bundler folds it at build time:
     * development builds always include the POC, production builds include
     * it only when built with `NEXT_PUBLIC_COLLAB_POC=1` (the Playwright web
     * server does this; deploy builds do not, so the whole branch — and the
     * dynamically imported POC chunk — is dead-code-eliminated).
     *
     * Removal condition: this flag and every `@/lib/collab/poc*` module are
     * deleted in Plan 12 when the relay transport replaces the local wiring.
     */
    if (
      process.env.NODE_ENV !== "production" ||
      process.env.NEXT_PUBLIC_COLLAB_POC === "1"
    ) {
      const params = new URLSearchParams(window.location.search);
      const roomIdRaw = params.get("collab-room");
      if (roomIdRaw) {
        void import("@/lib/collab/poc").then(({ startCollabPoc }) => {
          if (cancelled) return;
          handle = startCollabPoc({
            excalidrawApi: excalidrawAPI,
            roomIdRaw,
            usernameRaw: params.get("collab-user"),
            wrapRemoteApply,
          });
          if (handle) {
            handleRef.current = handle;
            setIsCollaborating(true);
          }
        });
      }
    }

    return () => {
      cancelled = true;
      handleRef.current = null;
      setIsCollaborating(false);
      handle?.destroy();
    };
  }, [excalidrawAPI, wrapRemoteApply]);

  const onPointerUpdate = useCallback(
    (payload: ExcalidrawPointerUpdatePayload) => {
      handleRef.current?.handlePointerUpdate(payload);
    },
    [],
  );

  const onSceneChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
      handleRef.current?.handleSceneChange(elements, appState);
    },
    [],
  );

  return { isCollaborating, onPointerUpdate, onSceneChange };
}
